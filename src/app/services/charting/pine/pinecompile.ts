/*
 * Pine Script static pass. Parses a script, reads its indicator() header,
 * lists its inputs and output calls (plot, fill, bgcolor, alertcondition…),
 * and rejects what Cyrus can't run yet with an error that names the feature
 * and the line. The result is what the runtime executes.
 */

type PineInputType = 'int' | 'float' | 'bool' | 'string' | 'color' | 'source' | 'timeframe';

interface PineInputDef {
  /** Stable settings key: a slug of the title, so reordering inputs keeps values. */
  key: string;
  type: PineInputType;
  def: number | boolean | string;
  title: string;
  tooltip?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: (number | string)[];
  group?: string;
  inline?: string;
  siteId: number;
  line: number;
}

type PineOutputKind = 'plot' | 'shape' | 'char' | 'arrow' | 'hline' | 'fill' | 'bg' | 'bar' | 'alertcondition';

interface PineOutputSite {
  key: string;
  kind: PineOutputKind;
  siteId: number;
  /** Title as written, when it's a plain string. */
  title: string;
  /** For alertconditions: the message as written. */
  message?: string;
  /** Position among plot() calls, for {{plot_N}}. */
  plotIndex?: number;
  line: number;
}

interface PineCompiled {
  version: number;
  title: string;
  shorttitle: string;
  overlay: boolean;
  precision: number | null;
  body: PN[];
  funcs: Map<string, PN>;
  inputs: PineInputDef[];
  inputBySite: Map<number, PineInputDef>;
  outputs: PineOutputSite[];
  outputBySite: Map<number, PineOutputSite>;
  alertConditions: PineOutputSite[];
  /** The script calls alert() somewhere. */
  usesAlertFn: boolean;
  warnings: string[];
}

const PineCompiler = (() => {
  /** Namespaces whose dotted names are built-ins rather than method calls. */
  const NAMESPACES = new Set(['ta', 'math', 'str', 'color', 'input', 'array', 'table', 'plot', 'shape', 'location',
    'size', 'position', 'display', 'hline', 'text', 'format', 'alert', 'barstate', 'timeframe', 'syminfo', 'order',
    'request', 'strategy', 'line', 'label', 'box', 'polyline', 'linefill', 'matrix', 'map', 'chart', 'runtime',
    'ticker', 'session', 'dayofweek', 'extend', 'xloc', 'yloc', 'font', 'currency', 'barmerge', 'earnings',
    'dividends', 'splits', 'adjustment', 'scale', 'log', 'time', 'math', 'backadjustment', 'settlement_as_close']);

  const UNSUPPORTED: Record<string, string> = {
    request: 'request.* (other symbols or timeframes) isn\'t supported yet. Cyrus runs scripts on the chart\'s own symbol and timeframe.',
    strategy: 'Strategies aren\'t supported. Only indicator() scripts can be added to a chart.',
    line: 'Drawing objects (line.*) aren\'t supported yet.',
    label: 'Drawing objects (label.*) aren\'t supported yet.',
    box: 'Drawing objects (box.*) aren\'t supported yet.',
    polyline: 'Drawing objects (polyline.*) aren\'t supported yet.',
    linefill: 'Drawing objects (linefill.*) aren\'t supported yet.',
    matrix: 'matrix.* isn\'t supported yet.',
    map: 'map.* isn\'t supported yet.',
    ticker: 'ticker.* isn\'t supported yet.',
    chart: 'chart.* isn\'t supported yet.',
    log: 'log.* (Pine Logs) isn\'t supported yet.',
  };

  const OUTPUT_FNS: Record<string, PineOutputKind> = {
    plot: 'plot', plotshape: 'shape', plotchar: 'char', plotarrow: 'arrow', plotbar: 'plot', plotcandle: 'plot',
    hline: 'hline', fill: 'fill', bgcolor: 'bg', barcolor: 'bar', alertcondition: 'alertcondition',
  };

  const INPUT_PARAMS: Record<string, string[]> = {
    'input': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm'],
    'input.int': ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'display'],
    'input.float': ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'display'],
    'input.bool': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
    'input.string': ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display'],
    'input.color': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
    'input.source': ['defval', 'title', 'tooltip', 'inline', 'group', 'display'],
    'input.timeframe': ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display'],
    'input.text_area': ['defval', 'title', 'tooltip', 'group', 'confirm', 'display'],
    'input.price': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
    'input.session': ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display'],
    'input.time': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  };

  const SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'];

  function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  }

  function err(msg: string, n: { line: number; col: number }): PineError {
    return new PineError(msg, n.line, n.col, 'compile');
  }

  /** Evaluate a constant argument (literals, named colours, simple maths). */
  function constValue(n: PN, version: number): any {
    switch (n.k) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'bool': return n.v;
      case 'na': return NaN;
      case 'color': return n.v;
      case 'unary': {
        const v = constValue(n.e, version);
        if (n.op === '-') return -v;
        if (n.op === '+') return +v;
        return !v;
      }
      case 'bin': {
        const l = constValue(n.l, version), r = constValue(n.r, version);
        switch (n.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return l / r;
          case '%': return l % r;
        }
        break;
      }
      case 'tuple': return n.items.map((i: PN) => constValue(i, version));
      case 'name': {
        const name: string = n.name;
        if (name.startsWith('color.')) {
          const c = PineColors.named(name.slice(6), version);
          if (c) return c;
        }
        if (SOURCES.includes(name)) return { source: name };
        const k = (typeof PineBuiltins !== 'undefined') ? PineBuiltins.constant(name) : undefined;
        if (k !== undefined) return k;
        break;
      }
      case 'call': {
        if (n.name === 'color.new' || n.name === 'color.rgb') {
          const a = n.args.map((x: PineArg) => constValue(x.value, version));
          if (n.name === 'color.new') return PineColors.isColor(a[0]) ? { ...a[0], t: a[1] ?? 0 } : NaN;
          return PineColors.rgb(a[0], a[1], a[2], a[3] ?? 0);
        }
        break;
      }
    }
    throw err('This input setting must be a constant value', n);
  }

  /** Map a call's arguments onto parameter names. */
  function argMap(n: PN, params: string[]): Map<string, PN> {
    const out = new Map<string, PN>();
    let pos = 0;
    for (const a of n.args as PineArg[]) {
      if (a.name) out.set(a.name, a.value);
      else if (pos < params.length) out.set(params[pos++], a.value);
    }
    return out;
  }

  function readInput(n: PN, version: number, count: number): PineInputDef {
    const fn: string = n.name;
    if (fn === 'input.symbol') throw err('input.symbol isn\'t supported yet: scripts run on the chart\'s own symbol', n);
    if (fn === 'input.enum') throw err('input.enum isn\'t supported yet', n);
    let params = INPUT_PARAMS[fn];
    if (!params) throw err(`Unknown input function '${fn}'`, n);
    // input.int/float(defval, title, options, ...) overload
    if ((fn === 'input.int' || fn === 'input.float') && (n.args as PineArg[])[2] && !(n.args as PineArg[])[2].name &&
        (n.args as PineArg[])[2].value.k === 'tuple') {
      params = ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display'];
    }
    const m = argMap(n, params);
    const get = (k: string) => (m.has(k) ? constValue(m.get(k)!, version) : undefined);
    const defNode = m.get('defval');
    if (!defNode) throw err(`${fn}() needs a default value`, n);
    const defval = get('defval');
    let type: PineInputType;
    switch (fn) {
      case 'input.int': case 'input.time': type = 'int'; break;
      case 'input.float': case 'input.price': type = 'float'; break;
      case 'input.bool': type = 'bool'; break;
      case 'input.string': case 'input.text_area': case 'input.session': type = 'string'; break;
      case 'input.color': type = 'color'; break;
      case 'input.source': type = 'source'; break;
      case 'input.timeframe': type = 'timeframe'; break;
      default:
        if (typeof defval === 'boolean') type = 'bool';
        else if (typeof defval === 'string') type = 'string';
        else if (PineColors.isColor(defval)) type = 'color';
        else if (defval && typeof defval === 'object' && defval.source) type = 'source';
        else type = defNode.k === 'num' && defNode.isInt ? 'int' : 'float';
    }
    let def: number | boolean | string;
    if (type === 'source') {
      if (!(defval && typeof defval === 'object' && defval.source)) throw err('input.source needs a price source such as close or hlc3', defNode);
      def = defval.source;
    } else if (type === 'color') {
      if (!PineColors.isColor(defval)) throw err('input.color needs a colour', defNode);
      def = PineColors.css(defval) as string;
    } else if (type === 'bool') {
      def = !!defval;
    } else if (type === 'string' || type === 'timeframe') {
      def = String(defval ?? '');
    } else {
      def = Number(defval);
      if (!isFinite(def)) def = 0;
    }
    const title = typeof get('title') === 'string' && get('title') ? String(get('title')) : '';
    const opts = get('options');
    const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : undefined);
    return {
      key: '', type, def, title: title || `Input ${count + 1}`,
      tooltip: typeof get('tooltip') === 'string' ? get('tooltip') : undefined,
      min: num(get('minval')), max: num(get('maxval')), step: num(get('step')),
      options: Array.isArray(opts) ? opts : undefined,
      group: typeof get('group') === 'string' ? get('group') : undefined,
      inline: typeof get('inline') === 'string' ? get('inline') : undefined,
      siteId: n.id, line: n.line,
    };
  }

  /** Walk every node, telling the visitor whether it's inside a local block. */
  function walk(nodes: PN[], visit: (n: PN, local: boolean, inFunc: boolean) => void, local = false, inFunc = false): void {
    const sub = (v: any, loc: boolean, fn: boolean) => {
      if (!v) return;
      if (Array.isArray(v)) { v.forEach((x) => sub(x, loc, fn)); return; }
      if (typeof v === 'object' && typeof v.k === 'string') { one(v, loc, fn); return; }
      if (typeof v === 'object' && v.value && typeof v.value.k === 'string') one(v.value, loc, fn);
    };
    const one = (n: PN, loc: boolean, fn: boolean) => {
      visit(n, loc, fn);
      switch (n.k) {
        case 'func':
          n.params.forEach((p: any) => p.def && one(p.def, true, true));
          sub(n.body, true, true);
          return;
        case 'if':
          one(n.cond, loc, fn);
          sub(n.then, true, fn);
          n.elifs.forEach((e: any) => { one(e.cond, true, fn); sub(e.body, true, fn); });
          sub(n.otherwise, true, fn);
          return;
        case 'switch':
          if (n.subject) one(n.subject, loc, fn);
          n.cases.forEach((c: any) => { if (c.cond) one(c.cond, true, fn); sub(c.body, true, fn); });
          return;
        case 'for':
          one(n.from, loc, fn); one(n.to, loc, fn); if (n.step) one(n.step, loc, fn);
          sub(n.body, true, fn);
          return;
        case 'forin':
          one(n.coll, loc, fn);
          sub(n.body, true, fn);
          return;
        case 'while':
          one(n.cond, loc, fn);
          sub(n.body, true, fn);
          return;
      }
      for (const key of Object.keys(n)) {
        if (key === 'k' || key === 'id' || key === 'line' || key === 'col') continue;
        sub(n[key], loc, fn);
      }
    };
    nodes.forEach((n) => one(n, local, inFunc));
  }

  const PURE_FNS = new Set(['color.new', 'color.rgb', 'color.r', 'color.g', 'color.b', 'color.t',
    'math.abs', 'math.round', 'math.max', 'math.min', 'math.pow', 'math.sqrt', 'math.floor', 'math.ceil']);

  /**
   * Flag sub-expressions that never change (literals, named colours and
   * constants, color.new() of those…). The runtime evaluates them once.
   */
  function markConstants(nodes: PN[], version: number): void {
    const isConst = (n: PN | null | undefined): boolean => {
      if (!n) return true;
      let c = false;
      switch (n.k) {
        case 'num': case 'str': case 'bool': case 'na': case 'color': c = true; break;
        case 'name':
          c = (n.name.startsWith('color.') && !!PineColors.named(n.name.slice(6), version)) ||
            (typeof PineBuiltins !== 'undefined' && PineBuiltins.constant(n.name) !== undefined);
          break;
        case 'unary': c = isConst(n.e); break;
        case 'bin': { const l = isConst(n.l), r = isConst(n.r); c = l && r; break; }
        case 'tern': { const a = isConst(n.cond), b = isConst(n.a), d = isConst(n.b); c = a && b && d; break; }
        case 'tuple': c = n.items.map(isConst).every(Boolean); break;
        case 'call': {
          const args = (n.args as PineArg[]).map((x) => isConst(x.value)).every(Boolean);
          c = PURE_FNS.has(n.name) && args;
          break;
        }
        default:
          visitChildren(n);
      }
      if (c) n.cst = true;
      return c;
    };
    const visitChildren = (n: PN) => {
      for (const key of Object.keys(n)) {
        if (key === 'k' || key === 'id' || key === 'line' || key === 'col') continue;
        const v = n[key];
        const each = (x: any) => {
          if (!x || typeof x !== 'object') return;
          if (typeof x.k === 'string') { isConst(x); return; }
          if (Array.isArray(x)) { x.forEach(each); return; }
          if (x.value && typeof x.value.k === 'string') isConst(x.value);
          if (x.cond && typeof x.cond.k === 'string') isConst(x.cond);
          if (x.def && typeof x.def.k === 'string') isConst(x.def);
          if (Array.isArray(x.body)) x.body.forEach(each);
        };
        each(v);
      }
    };
    nodes.forEach((n) => isConst(n));
  }

  function compile(src: string): PineCompiled {
    const v = PineLexer.version(src);
    const warnings: string[] = [];
    const version = v ?? 6;
    if (v == null) warnings.push('No //@version line: running it as Pine v6.');
    if (version < 5) {
      throw new PineError(`This is a Pine v${version} script. Cyrus runs Pine v5 and v6. In TradingView, use "Convert to v5/v6" first.`, 1, 1, 'compile');
    }
    if (version > 6) throw new PineError(`Pine v${version} isn't supported yet (Cyrus runs v5 and v6)`, 1, 1, 'compile');
    const body = PineParser.parse(src);

    const out: PineCompiled = {
      version, title: 'Custom indicator', shorttitle: '', overlay: false, precision: null, body,
      funcs: new Map(), inputs: [], inputBySite: new Map(), outputs: [], outputBySite: new Map(),
      alertConditions: [], usesAlertFn: false, warnings,
    };

    let declared = false;
    for (const s of body) {
      if (s.k === 'func') {
        out.funcs.set(s.name, s);
        continue;
      }
      if (s.k !== 'expr' || s.e.k !== 'call') continue;
      const name = s.e.name;
      if (name === 'study') throw err('study() is Pine v4. Cyrus runs Pine v5 and v6 (use indicator()).', s);
      if (name === 'strategy') throw err(UNSUPPORTED.strategy, s);
      if (name === 'library') throw err('Libraries can\'t be added to a chart.', s);
      if (name !== 'indicator') continue;
      if (declared) throw err('A script can only have one indicator() call', s);
      declared = true;
      const m = argMap(s.e, ['title', 'shorttitle', 'overlay', 'format', 'precision', 'scale', 'max_bars_back', 'timeframe']);
      const get = (k: string) => (m.has(k) ? constValue(m.get(k)!, version) : undefined);
      out.title = typeof get('title') === 'string' && get('title') ? get('title') : out.title;
      out.shorttitle = typeof get('shorttitle') === 'string' ? get('shorttitle') : '';
      out.overlay = get('overlay') === true;
      const prec = get('precision');
      out.precision = typeof prec === 'number' && isFinite(prec) ? Math.max(0, Math.min(16, Math.round(prec))) : null;
      const tf = get('timeframe');
      if (typeof tf === 'string' && tf) throw err('indicator(timeframe=…) isn\'t supported yet', s);
    }
    if (!declared) throw new PineError('A script needs an indicator("Name") call', 1, 1, 'compile');

    const keys = new Set<string>();
    const uniqueKey = (base: string, fallback: string) => {
      let k = slug(base) || fallback;
      if (keys.has(k)) { let i = 2; while (keys.has(`${k}_${i}`)) i++; k = `${k}_${i}`; }
      keys.add(k);
      return k;
    };
    let plotIndex = 0;

    walk(body, (n, local, inFunc) => {
      if (n.k === 'name' || n.k === 'call') {
        const name: string = n.name;
        const dot = name.indexOf('.');
        const ns = dot > 0 ? name.slice(0, dot) : '';
        if (ns && UNSUPPORTED[ns]) throw err(UNSUPPORTED[ns], n);
      }
      if (n.k !== 'call') return;
      const name: string = n.name;
      if (name === 'alert') out.usesAlertFn = true;
      if (name === 'input' || name.startsWith('input.')) {
        if (local) throw err('Inputs must be declared at the top level of the script, not inside a block or function', n);
        const def = readInput(n, version, out.inputs.length);
        def.key = uniqueKey(def.title, `in_${out.inputs.length}`);
        out.inputs.push(def);
        out.inputBySite.set(n.id, def);
        return;
      }
      const kind = OUTPUT_FNS[name];
      if (kind) {
        if (name === 'plotbar' || name === 'plotcandle') throw err(`${name}() isn't supported yet`, n);
        if (local) throw err(`Cannot use '${name}' in local scope (inside a block or function)`, n);
        const titleParam = kind === 'alertcondition' ? 1 : kind === 'bg' || kind === 'bar' ? 4 : kind === 'fill' ? 3 : 1;
        const named = (n.args as PineArg[]).find((a) => a.name === 'title');
        const posArg = (n.args as PineArg[])[titleParam];
        const tNode = named ? named.value : posArg && !posArg.name ? posArg.value : null;
        const title = tNode && tNode.k === 'str' ? tNode.v : '';
        const site: PineOutputSite = { key: '', kind, siteId: n.id, title, line: n.line };
        if (kind === 'plot') site.plotIndex = plotIndex++;
        if (kind === 'alertcondition') {
          const mNamed = (n.args as PineArg[]).find((a) => a.name === 'message');
          const mPos = (n.args as PineArg[])[2];
          const mNode = mNamed ? mNamed.value : mPos && !mPos.name ? mPos.value : null;
          site.message = mNode && mNode.k === 'str' ? mNode.v : '';
          site.title = title || `Alert ${out.alertConditions.length + 1}`;
          site.key = uniqueKey(`alert_${title}`, `alert_${out.alertConditions.length}`);
          out.alertConditions.push(site);
        } else {
          site.key = uniqueKey(title, `${kind}_${out.outputs.length}`);
        }
        out.outputs.push(site);
        out.outputBySite.set(n.id, site);
        return;
      }
      if (name === 'indicator') {
        if (local) throw err('indicator() must be at the top level', n);
        return;
      }
      if (out.funcs.has(name)) return;
      if (typeof PineBuiltins !== 'undefined' && PineBuiltins.hasFn(name)) return;
      const dot = name.lastIndexOf('.');
      if (dot > 0 && !NAMESPACES.has(name.slice(0, name.indexOf('.')))) return; // method call on a variable
      const hint = dot < 0 && typeof PineBuiltins !== 'undefined' && PineBuiltins.hasFn(`ta.${name}`) ? ` (did you mean ta.${name}? This looks like Pine v4)` : '';
      throw err(`Unknown function '${name}'${hint}`, n);
    });

    markConstants(body, version);

    // Nested function definitions aren't allowed in Pine either.
    walk(body, (n, local) => { if (n.k === 'func' && local) throw err('Functions must be defined at the top level', n); });
    return out;
  }

  return { compile, slug, NAMESPACES, SOURCES };
})();
