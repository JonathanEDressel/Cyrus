/*
 * Pine Script runtime. Executes a compiled script once per bar, oldest
 * first, the way TradingView does.
 *
 * Every variable is a series: a cell that keeps the value it ended each
 * execution with, so `x[1]` reads the previous one. A `[n]` on anything
 * other than a plain name gets a hidden cell of its own. Cells and built-in
 * state are keyed by node id inside a context; each call site of a user
 * function gets its own child context, so a function that calls ta.ema()
 * keeps a separate running average per place it's called from.
 */

interface PineOutput {
  key: string;
  kind: PineOutputKind;
  title: string;
  plotIndex?: number;
  style: string;
  width: number;
  /** display.* bitmask: 1 pane, 2 data window, 4 price scale, 8 status line. */
  display: number;
  /** Default colour (CSS) when a bar's colour isn't given. */
  color: string | null;
  values: Float64Array;
  colors: (string | null)[];
  offset: number;
  histbase: number;
  editable: boolean;
  // plotshape / plotchar / plotarrow
  shape?: string;
  location?: string;
  char?: string;
  text?: string;
  textColor?: string | null;
  size?: string;
  // hline
  price?: number;
  lineStyle?: string;
  // fill: the two outputs it fills between
  a?: string;
  b?: string;
}

interface PineAlertResult { key: string; title: string; message: string; hits: Uint8Array; }

interface PineRunResult {
  outputs: PineOutput[];
  tables: PineTable[];
  alerts: PineAlertResult[];
  /** alert() calls: the bar they fired on and their message. */
  alertCalls: { bar: number; message: string }[];
  error: PineError | null;
  ms: number;
}

class PineCell {
  h: any[] = [];
  v: any = NaN;
  init = false;
}

class PineCtx {
  cells = new Map<number, PineCell>();
  kids = new Map<number, PineCtx>();
  st = new Map<number, any>();
}

class PineScope {
  vars = new Map<string, PineCell>();
  constructor(public parent: PineScope | null) {}
}

const PINE_OUT_PARAMS: Record<string, string[]> = {
  plot: ['series', 'title', 'color', 'linewidth', 'style', 'trackprice', 'histbase', 'offset', 'join', 'editable', 'show_last', 'display', 'format', 'precision', 'force_overlay', 'linestyle'],
  plotshape: ['series', 'title', 'style', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display', 'format', 'precision', 'force_overlay'],
  plotchar: ['series', 'title', 'char', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display', 'format', 'precision', 'force_overlay'],
  plotarrow: ['series', 'title', 'colorup', 'colordown', 'offset', 'minheight', 'maxheight', 'editable', 'show_last', 'display', 'format', 'precision', 'force_overlay'],
  hline: ['price', 'title', 'color', 'linestyle', 'linewidth', 'editable', 'display'],
  fill: ['plot1', 'plot2', 'color', 'title', 'editable', 'show_last', 'fillgaps', 'display', 'top_value', 'bottom_value', 'top_color', 'bottom_color'],
  fillGradient: ['plot1', 'plot2', 'top_value', 'bottom_value', 'top_color', 'bottom_color', 'title', 'display', 'fillgaps', 'editable'],
  bgcolor: ['color', 'offset', 'editable', 'show_last', 'title', 'display', 'force_overlay'],
  barcolor: ['color', 'offset', 'editable', 'show_last', 'title', 'display'],
  alertcondition: ['condition', 'title', 'message'],
  alert: ['message', 'freq'],
};

const PINE_MAX_ITERATIONS = 5_000_000;

class PineRunner implements PineHost {
  i = 0;
  version: number;
  private root = new PineCtx();
  private global = new PineScope(null);
  private outs = new Map<number, PineOutput>();
  private configured = new Set<number>();
  private alertsBySite = new Map<number, PineAlertResult>();
  private alertCalls: { bar: number; message: string }[] = [];
  private tables = new Map<number, PineTable>();
  private preCache = new Map<string, Float64Array>();
  private flow = 0; // 1 break, 2 continue
  private steps = 0;
  private iterations = 0;
  private depth = 0;
  private deadline = 0;
  private curNode: PN | null = null;

  constructor(private c: PineCompiled, public bars: ChartBar[], private params: Record<string, any>, public opts: PineRunOptions) {
    this.version = c.version;
  }

  static run(c: PineCompiled, bars: ChartBar[], params: Record<string, any>, opts: PineRunOptions): PineRunResult {
    return new PineRunner(c, bars, params || {}, opts).run();
  }

  // ── PineHost ──────────────────────────────────────────────────────────

  pre(name: string): Float64Array {
    let a = this.preCache.get(name);
    if (!a) { a = PineBuiltins.precompute(name, this.bars); this.preCache.set(name, a); }
    return a;
  }

  addTable(siteId: number, t: PineTable): void {
    this.tables.set(siteId, t);
  }

  // ── Run ───────────────────────────────────────────────────────────────

  private run(): PineRunResult {
    const t0 = performance.now();
    this.deadline = t0 + (this.opts.maxMs ?? 1500);
    const n = this.bars.length;
    for (const site of this.c.outputs) {
      if (site.kind === 'alertcondition') {
        this.alertsBySite.set(site.siteId, { key: site.key, title: site.title, message: site.message || '', hits: new Uint8Array(n) });
        continue;
      }
      this.outs.set(site.siteId, {
        key: site.key, kind: site.kind, title: site.title || site.key, plotIndex: site.plotIndex,
        style: site.kind === 'plot' ? 'line' : '', width: 1, display: 15, color: null,
        values: new Float64Array(n).fill(NaN), colors: new Array(n).fill(null),
        offset: 0, histbase: 0, editable: true,
      });
    }
    let error: PineError | null = null;
    try {
      for (let i = 0; i < n; i++) {
        this.i = i;
        this.execBlock(this.c.body, this.global, this.root);
        this.flow = 0;
      }
    } catch (e: any) {
      const node = this.curNode;
      if (e instanceof PineError) {
        error = e;
        if (!error.line && node) { error.line = node.line; error.col = node.col; }
      } else {
        error = new PineError(`Script failed: ${e?.message || e}`, node?.line || 0, node?.col || 0, 'runtime');
      }
      if (error.kind !== 'runtime') error.kind = 'runtime';
    }
    const outputs = Array.from(this.outs.values());
    for (const o of outputs) {
      if (o.offset) this.shift(o);
      // A series colour that was na on the first bar: its first real colour is the default.
      if (o.color == null && (o.kind === 'plot' || o.kind === 'shape' || o.kind === 'char')) {
        o.color = o.colors.find((c) => c != null) || '#2962FF';
      }
    }
    return {
      outputs,
      tables: Array.from(this.tables.values()).filter((t) => !t.deleted),
      alerts: Array.from(this.alertsBySite.values()),
      alertCalls: this.alertCalls,
      error,
      ms: performance.now() - t0,
    };
  }

  /** Move an output's values `offset` bars right (or left). */
  private shift(o: PineOutput): void {
    const n = o.values.length, k = o.offset;
    const v = new Float64Array(n).fill(NaN), c: (string | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const j = i + k;
      if (j >= 0 && j < n) { v[j] = o.values[i]; c[j] = o.colors[i]; }
    }
    o.values = v;
    o.colors = c;
  }

  private fail(msg: string, node: PN | null): never {
    throw new PineError(msg, node?.line || 0, node?.col || 0, 'runtime');
  }

  private cell(ctx: PineCtx, key: number): PineCell {
    let c = ctx.cells.get(key);
    if (!c) { c = new PineCell(); ctx.cells.set(key, c); }
    return c;
  }

  /** Start a new execution of a cell: the last value moves into history. */
  private roll(c: PineCell): void {
    if (!c.init) return;
    c.h.push(c.v);
    if (c.h.length > 20000) c.h.splice(0, 10000);
  }

  private lookup(name: string, scope: PineScope): PineCell | undefined {
    for (let s: PineScope | null = scope; s; s = s.parent) {
      const c = s.vars.get(name);
      if (c) return c;
    }
    return undefined;
  }

  // ── Statements ────────────────────────────────────────────────────────

  private execBlock(stmts: PN[], scope: PineScope, ctx: PineCtx): any {
    let v: any = NaN;
    for (const s of stmts) {
      if ((++this.steps & 4095) === 0 && performance.now() > this.deadline) {
        this.fail('The script took too long to run on this chart', s);
      }
      v = this.exec(s, scope, ctx);
      if (this.flow) break;
    }
    return v;
  }

  private exec(n: PN, scope: PineScope, ctx: PineCtx): any {
    this.curNode = n;
    switch (n.k) {
      case 'decl': {
        const c = this.cell(ctx, n.id);
        if (n.mode) {
          if (!c.init) { c.v = this.eval(n.value, scope, ctx); c.init = true; }
          else this.roll(c);
        } else {
          this.roll(c);
          c.v = this.eval(n.value, scope, ctx);
          c.init = true;
        }
        if (n.typeName === 'bool' && PineBuiltins.isNa(c.v)) c.v = false;
        scope.vars.set(n.name, c);
        return c.v;
      }
      case 'tdecl': {
        const v = this.eval(n.value, scope, ctx);
        if (!Array.isArray(v)) this.fail(`Expected a tuple on the right of [${n.names.join(', ')}] =`, n);
        n.names.forEach((name: string, k: number) => {
          const c = this.cell(ctx, -(n.id * 64 + k + 1));
          this.roll(c);
          c.v = v[k] === undefined ? NaN : v[k];
          c.init = true;
          scope.vars.set(name, c);
        });
        return v;
      }
      case 'assign': {
        const c = this.lookup(n.name, scope);
        if (!c) this.fail(`Undeclared identifier '${n.name}' (declare it with = before using :=)`, n);
        const v = this.eval(n.value, scope, ctx);
        switch (n.op) {
          case ':=': c.v = v; break;
          case '+=': c.v = this.arith('+', c.v, v); break;
          case '-=': c.v = this.arith('-', c.v, v); break;
          case '*=': c.v = this.arith('*', c.v, v); break;
          case '/=': c.v = this.arith('/', c.v, v); break;
          case '%=': c.v = this.arith('%', c.v, v); break;
        }
        return c.v;
      }
      case 'expr': return this.eval(n.e, scope, ctx);
      case 'func': return NaN;
      case 'break': this.flow = 1; return NaN;
      case 'continue': this.flow = 2; return NaN;
    }
    return this.eval(n, scope, ctx);
  }

  // ── Expressions ───────────────────────────────────────────────────────

  private arith(op: string, a: any, b: any, lInt = false, rInt = false): any {
    if (op === '+' && (typeof a === 'string' || typeof b === 'string')) {
      return PineBuiltins.toStr(a) + PineBuiltins.toStr(b);
    }
    const x = PineBuiltins.num(a), y = PineBuiltins.num(b);
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': {
        if (y === 0) return NaN;
        const q = x / y;
        return lInt && rInt && this.version < 6 ? Math.trunc(q) : q;
      }
      case '%': return y === 0 ? NaN : x % y;
    }
    return NaN;
  }

  private eq(a: any, b: any): boolean {
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (PineColors.isColor(a) && PineColors.isColor(b)) return a.r === b.r && a.g === b.g && a.b === b.b && a.t === b.t;
    return a === b;
  }

  private isNaNum(v: any): boolean {
    return v === null || v === undefined || (typeof v === 'number' && isNaN(v));
  }

  private eval(n: PN, scope: PineScope, ctx: PineCtx): any {
    if (n.cst) {
      // Never changes (see PineCompiler.markConstants): work it out once.
      const cv = n.cv;
      if (cv !== undefined) return cv;
      n.cst = false;
      const v = this.eval(n, scope, ctx);
      n.cst = true;
      n.cv = v;
      return v;
    }
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'color': return n.v;
      case 'na': return NaN;
      case 'name': return this.name(n, scope);
      case 'hist': return this.hist(n, scope, ctx);
      case 'unary': {
        const v = this.eval(n.e, scope, ctx);
        if (n.op === 'not') return !PineBuiltins.truthy(v);
        return n.op === '-' ? -PineBuiltins.num(v) : PineBuiltins.num(v);
      }
      case 'bin': {
        const op = n.op;
        if (op === 'and') return PineBuiltins.truthy(this.eval(n.l, scope, ctx)) && PineBuiltins.truthy(this.eval(n.r, scope, ctx));
        if (op === 'or') return PineBuiltins.truthy(this.eval(n.l, scope, ctx)) || PineBuiltins.truthy(this.eval(n.r, scope, ctx));
        const a = this.eval(n.l, scope, ctx), b = this.eval(n.r, scope, ctx);
        switch (op) {
          case '==': return !this.isNaNum(a) && !this.isNaNum(b) && this.eq(a, b);
          case '!=': return !this.isNaNum(a) && !this.isNaNum(b) && !this.eq(a, b);
          case '<': return PineBuiltins.num(a) < PineBuiltins.num(b) || (typeof a === 'string' && a < b);
          case '>': return PineBuiltins.num(a) > PineBuiltins.num(b) || (typeof a === 'string' && a > b);
          case '<=': return PineBuiltins.num(a) <= PineBuiltins.num(b);
          case '>=': return PineBuiltins.num(a) >= PineBuiltins.num(b);
        }
        return this.arith(op, a, b, n.l.k === 'num' && n.l.isInt, n.r.k === 'num' && n.r.isInt);
      }
      case 'tern':
        return PineBuiltins.truthy(this.eval(n.cond, scope, ctx)) ? this.eval(n.a, scope, ctx) : this.eval(n.b, scope, ctx);
      case 'tuple': return n.items.map((x: PN) => this.eval(x, scope, ctx));
      case 'call': return this.call(n, scope, ctx);
      case 'if': {
        if (PineBuiltins.truthy(this.eval(n.cond, scope, ctx))) return this.execBlock(n.then, new PineScope(scope), ctx);
        for (const e of n.elifs) {
          if (PineBuiltins.truthy(this.eval(e.cond, scope, ctx))) return this.execBlock(e.body, new PineScope(scope), ctx);
        }
        return n.otherwise ? this.execBlock(n.otherwise, new PineScope(scope), ctx) : NaN;
      }
      case 'switch': {
        const subject = n.subject ? this.eval(n.subject, scope, ctx) : undefined;
        for (const cs of n.cases) {
          const hit = !cs.cond || (n.subject
            ? this.eq(subject, this.eval(cs.cond, scope, ctx))
            : PineBuiltins.truthy(this.eval(cs.cond, scope, ctx)));
          if (hit) return this.execBlock(cs.body, new PineScope(scope), ctx);
        }
        return NaN;
      }
      case 'for': return this.forLoop(n, scope, ctx);
      case 'forin': return this.forIn(n, scope, ctx);
      case 'while': {
        let v: any = NaN;
        while (PineBuiltins.truthy(this.eval(n.cond, scope, ctx))) {
          this.tick(n);
          v = this.execBlock(n.body, new PineScope(scope), ctx);
          if (this.flow === 1) { this.flow = 0; break; }
          this.flow = 0;
        }
        return v;
      }
    }
    return this.exec(n, scope, ctx);
  }

  private tick(n: PN): void {
    if (++this.iterations > PINE_MAX_ITERATIONS) this.fail('Loop limit exceeded: a loop ran too many times', n);
    if ((this.iterations & 1023) === 0 && performance.now() > this.deadline) this.fail('The script took too long to run on this chart', n);
  }

  private forLoop(n: PN, scope: PineScope, ctx: PineCtx): any {
    const from = PineBuiltins.num(this.eval(n.from, scope, ctx));
    const to = PineBuiltins.num(this.eval(n.to, scope, ctx));
    if (isNaN(from) || isNaN(to)) return NaN;
    let step = n.step ? Math.abs(PineBuiltins.num(this.eval(n.step, scope, ctx))) : 1;
    if (!(step > 0)) this.fail('The for loop step must be a positive number', n);
    if (from > to) step = -step;
    const cell = this.cell(ctx, -(n.id * 64 + 1));
    let v: any = NaN;
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      this.tick(n);
      const s = new PineScope(scope);
      cell.v = i;
      cell.init = true;
      s.vars.set(n.v, cell);
      v = this.execBlock(n.body, s, ctx);
      if (this.flow === 1) { this.flow = 0; break; }
      this.flow = 0;
    }
    return v;
  }

  private forIn(n: PN, scope: PineScope, ctx: PineCtx): any {
    const coll = this.eval(n.coll, scope, ctx);
    const items: any[] = coll instanceof PineArray ? coll.items : Array.isArray(coll) ? coll : null as any;
    if (!items) this.fail('for … in needs an array', n);
    const itemCell = this.cell(ctx, -(n.id * 64 + 1)), idxCell = this.cell(ctx, -(n.id * 64 + 2));
    let v: any = NaN;
    for (let i = 0; i < items.length; i++) {
      this.tick(n);
      const s = new PineScope(scope);
      itemCell.v = items[i]; itemCell.init = true;
      s.vars.set(n.item, itemCell);
      if (n.idx) { idxCell.v = i; idxCell.init = true; s.vars.set(n.idx, idxCell); }
      v = this.execBlock(n.body, s, ctx);
      if (this.flow === 1) { this.flow = 0; break; }
      this.flow = 0;
    }
    return v;
  }

  private name(n: PN, scope: PineScope): any {
    const name: string = n.name;
    const c = this.lookup(name, scope);
    if (c) return c.v;
    if (PineBuiltins.PRICE_SERIES.has(name)) return PineBuiltins.priceAt(this.bars, this.i, name);
    const v = PineBuiltins.VARS[name];
    if (v) return v(this);
    if (name.startsWith('color.')) {
      const col = PineColors.named(name.slice(6), this.version);
      if (col) return col;
    }
    const k = PineBuiltins.constant(name);
    if (k !== undefined) return k;
    if (this.c.funcs.has(name)) this.fail(`'${name}' is a function: call it with ${name}(…)`, n);
    this.fail(`Undeclared identifier '${name}'`, n);
  }

  private hist(n: PN, scope: PineScope, ctx: PineCtx): any {
    const off = Math.trunc(PineBuiltins.num(this.eval(n.off, scope, ctx)));
    if (!(off >= 0)) this.fail('The history offset in [ ] must be 0 or more', n);
    const e = n.e;
    if (e.k === 'name') {
      const c = this.lookup(e.name, scope);
      if (c) {
        if (off === 0) return c.v;
        const j = c.h.length - off;
        return j >= 0 ? c.h[j] : NaN;
      }
      if (PineBuiltins.PRICE_SERIES.has(e.name)) return PineBuiltins.priceAt(this.bars, this.i - off, e.name);
    }
    const v = this.eval(e, scope, ctx);
    const c = this.cell(ctx, n.id);
    this.roll(c);
    c.v = v;
    c.init = true;
    if (off === 0) return v;
    const j = c.h.length - off;
    return j >= 0 ? c.h[j] : NaN;
  }

  // ── Calls ─────────────────────────────────────────────────────────────

  /**
   * Which argument node fills each parameter, worked out once per call site
   * (the map is cached on the node, keyed by the parameter list).
   */
  private argNodes(n: PN, params: string[], aliases?: Record<string, string>): (PN | undefined)[] {
    const cache: Map<string[], (PN | undefined)[]> = n.__args || (n.__args = new Map());
    let nodes = cache.get(params);
    if (nodes) return nodes;
    nodes = new Array(params.length).fill(undefined);
    let pos = 0;
    for (const a of n.args as PineArg[]) {
      if (!a.name) {
        if (pos < params.length) nodes[pos] = a.value;
        pos++;
        continue;
      }
      const k = params.indexOf((aliases && aliases[a.name]) || a.name);
      if (k < 0) this.fail(`${n.name}() has no argument called '${a.name}'`, n);
      nodes[k] = a.value;
    }
    cache.set(params, nodes);
    return nodes;
  }

  /** Evaluate a call's arguments onto parameter names (undefined = not given). */
  private args(n: PN, params: string[], scope: PineScope, ctx: PineCtx, aliases?: Record<string, string>, only?: number[]): any[] {
    const nodes = this.argNodes(n, params, aliases);
    const out: any[] = new Array(params.length);
    if (only) {
      for (const k of only) { const a = nodes[k]; out[k] = a ? this.eval(a, scope, ctx) : undefined; }
      return out;
    }
    for (let k = 0; k < nodes.length; k++) {
      const a = nodes[k];
      out[k] = a ? this.eval(a, scope, ctx) : undefined;
    }
    return out;
  }

  private call(n: PN, scope: PineScope, ctx: PineCtx): any {
    const name: string = n.name;
    // What this call site is, worked out once (the node belongs to one compiled script).
    let kind: number = n.__kind;
    if (kind === undefined) {
      kind = this.c.funcs.has(name) ? 1 : this.c.inputBySite.has(n.id) ? 2 : this.c.outputBySite.has(n.id) ? 3
        : name === 'indicator' || name === 'max_bars_back' ? 4 : 0;
      n.__kind = kind;
    }
    switch (kind) {
      case 1: return this.callUser(this.c.funcs.get(name)!, n, scope, ctx);
      case 2: return this.inputValue(this.c.inputBySite.get(n.id)!);
      case 3: return this.output(n, this.c.outputBySite.get(n.id)!, scope, ctx);
      case 4: return NaN;
    }
    if (name === 'alert') {
      const a = this.args(n, PINE_OUT_PARAMS.alert, scope, ctx);
      this.alertCalls.push({ bar: this.i, message: PineBuiltins.toStr(a[0]) });
      return NaN;
    }

    let d = PineBuiltins.FNS[name];
    let self: any = undefined;
    if (!d) {
      // Method syntax: arr.push(x), t.cell(...), s.contains(...)
      const dot = name.lastIndexOf('.');
      if (dot > 0 && !PineCompiler.NAMESPACES.has(name.slice(0, name.indexOf('.')))) {
        const objName = name.slice(0, dot), method = name.slice(dot + 1);
        const c = this.lookup(objName, scope);
        if (!c) this.fail(`Undeclared identifier '${objName}'`, n);
        self = c.v;
        const ns = self instanceof PineArray ? 'array' : self instanceof PineTable ? 'table'
          : typeof self === 'string' ? 'str' : PineColors.isColor(self) ? 'color' : null;
        d = ns ? PineBuiltins.FNS[`${ns}.${method}`] : undefined as any;
        if (!d) this.fail(`'${objName}' has no method '${method}'`, n);
      } else {
        this.fail(`Unknown function '${name}'`, n);
      }
    }
    let a: any[];
    if (d.variadic) {
      a = (n.args as PineArg[]).map((x) => this.eval(x.value, scope, ctx));
    } else {
      const params = self !== undefined ? d.p.slice(1) : d.p;
      a = this.args(n, params, scope, ctx);
    }
    if (self !== undefined) a.unshift(self);
    let st = ctx.st.get(n.id);
    if (!st) { st = {}; ctx.st.set(n.id, st); }
    return d.f(a, this, st, n);
  }

  private callUser(fn: PN, n: PN, scope: PineScope, ctx: PineCtx): any {
    if (this.depth > 64) this.fail(`Too many nested calls to '${fn.name}' (functions can't call themselves)`, n);
    const params: { name: string; def: PN | null }[] = fn.params;
    const given: any[] = new Array(params.length).fill(undefined);
    let pos = 0;
    for (const a of n.args as PineArg[]) {
      const v = this.eval(a.value, scope, ctx);
      if (!a.name) {
        if (pos >= params.length) this.fail(`${fn.name}() takes ${params.length} argument(s)`, n);
        given[pos++] = v;
      } else {
        const k = params.findIndex((p) => p.name === a.name);
        if (k < 0) this.fail(`${fn.name}() has no parameter called '${a.name}'`, n);
        given[k] = v;
      }
    }
    let kid = ctx.kids.get(n.id);
    if (!kid) { kid = new PineCtx(); ctx.kids.set(n.id, kid); }
    const fscope = new PineScope(this.global);
    params.forEach((p, k) => {
      let v = given[k];
      if (v === undefined) {
        if (!p.def) this.fail(`${fn.name}() is missing the '${p.name}' argument`, n);
        v = this.eval(p.def, fscope, kid!);
      }
      const c = this.cell(kid!, -(fn.id * 64 + k + 1));
      this.roll(c);
      c.v = v;
      c.init = true;
      fscope.vars.set(p.name, c);
    });
    this.depth++;
    try {
      const r = this.execBlock(fn.body, fscope, kid);
      this.flow = 0;
      return r;
    } finally {
      this.depth--;
    }
  }

  private inputCache = new Map<string, any>();

  private inputValue(def: PineInputDef): any {
    if (def.type !== 'source' && this.inputCache.has(def.key)) return this.inputCache.get(def.key);
    const v = this.inputRaw(def);
    if (def.type !== 'source') this.inputCache.set(def.key, v);
    return v;
  }

  private inputRaw(def: PineInputDef): any {
    let v = this.params[def.key];
    if (v === undefined || v === null || (typeof v === 'number' && !isFinite(v))) v = def.def;
    switch (def.type) {
      case 'source': return PineBuiltins.priceAt(this.bars, this.i, PineCompiler.SOURCES.includes(String(v)) ? String(v) : String(def.def));
      case 'color': return PineColors.parse(String(v)) || PineColors.parse(String(def.def)) || NaN;
      case 'bool': return v === true || v === 'true';
      case 'int': return Math.round(Number(v));
      case 'float': return Number(v);
      default: return String(v);
    }
  }

  private output(n: PN, site: PineOutputSite, scope: PineScope, ctx: PineCtx): any {
    const name: string = n.name;
    if (site.kind === 'alertcondition') {
      const firstAlert = !this.configured.has(site.siteId);
      if (firstAlert) this.configured.add(site.siteId);
      const a = this.args(n, PINE_OUT_PARAMS.alertcondition, scope, ctx, undefined, firstAlert ? undefined : [0]);
      const r = this.alertsBySite.get(site.siteId)!;
      r.hits[this.i] = PineBuiltins.truthy(a[0]) ? 1 : 0;
      if (typeof a[2] === 'string') r.message = a[2];
      if (typeof a[1] === 'string' && a[1]) r.title = a[1];
      return NaN;
    }
    const o = this.outs.get(site.siteId)!;
    const i = this.i;
    const first = !this.configured.has(site.siteId);
    if (first) this.configured.add(site.siteId);
    const css = PineColors.css;
    const disp = (v: any) => (typeof v === 'number' && isFinite(v) ? v : 15);
    const title = (v: any) => { if (typeof v === 'string' && v) o.title = v; };
    const ref = { __out: o.key };

    switch (name) {
      case 'plot': {
        const a = this.args(n, PINE_OUT_PARAMS.plot, scope, ctx, undefined, first ? undefined : [0, 2]);
        if (first) {
          title(a[1]);
          o.color = a[2] === undefined ? '#2962FF' : css(a[2]);
          o.width = Math.max(1, Math.min(10, PineBuiltins.num(a[3]) || 1));
          o.style = typeof a[4] === 'string' ? a[4] : 'line';
          o.histbase = PineBuiltins.num(a[6]) || 0;
          o.offset = Math.trunc(PineBuiltins.num(a[7]) || 0);
          o.editable = a[9] !== false;
          o.display = disp(a[11]);
          o.lineStyle = typeof a[15] === 'string' ? a[15] : 'solid';
        }
        o.values[i] = PineBuiltins.num(a[0]);
        o.colors[i] = a[2] === undefined ? o.color : css(a[2]);
        return ref;
      }
      case 'plotshape':
      case 'plotchar': {
        const shape = name === 'plotshape';
        const a = this.args(n, PINE_OUT_PARAMS[name], scope, ctx, undefined, first ? undefined : [0, 4]);
        if (first) {
          title(a[1]);
          if (shape) o.shape = typeof a[2] === 'string' ? a[2] : 'xcross';
          else o.char = typeof a[2] === 'string' && a[2] ? Array.from(a[2] as string)[0] : '★';
          o.location = typeof a[3] === 'string' ? a[3] : 'abovebar';
          o.color = a[4] === undefined ? '#2962FF' : css(a[4]);
          o.offset = Math.trunc(PineBuiltins.num(a[5]) || 0);
          o.text = typeof a[6] === 'string' ? a[6] : '';
          o.textColor = a[7] === undefined ? null : css(a[7]);
          o.editable = a[8] !== false;
          o.size = typeof a[9] === 'string' ? a[9] : 'auto';
          o.display = disp(a[11]);
        }
        const v = a[0];
        const hit = PineBuiltins.truthy(v);
        o.values[i] = hit ? (typeof v === 'number' ? v : 1) : NaN;
        o.colors[i] = a[4] === undefined ? o.color : css(a[4]);
        return ref;
      }
      case 'plotarrow': {
        const a = this.args(n, PINE_OUT_PARAMS.plotarrow, scope, ctx, undefined, first ? undefined : [0, 2, 3]);
        if (first) {
          title(a[1]);
          o.offset = Math.trunc(PineBuiltins.num(a[4]) || 0);
          o.display = disp(a[9]);
        }
        const v = PineBuiltins.num(a[0]);
        o.values[i] = v && !isNaN(v) ? v : NaN;
        o.colors[i] = v > 0 ? (a[2] === undefined ? '#4CAF50' : css(a[2])) : (a[3] === undefined ? '#F23645' : css(a[3]));
        return ref;
      }
      case 'hline': {
        const a = this.args(n, PINE_OUT_PARAMS.hline, scope, ctx);
        title(a[1]);
        o.price = PineBuiltins.num(a[0]);
        o.color = a[2] === undefined ? 'rgba(120,123,134,1)' : css(a[2]);
        o.lineStyle = typeof a[3] === 'string' ? a[3] : 'dashed';
        o.width = Math.max(1, PineBuiltins.num(a[4]) || 1);
        o.editable = a[5] !== false;
        o.display = disp(a[6]);
        return { __out: o.key, hline: true };
      }
      case 'fill': {
        const alias = { hline1: 'plot1', hline2: 'plot2' };
        let a = this.args(n, PINE_OUT_PARAMS.fill, scope, ctx, alias);
        let color: any;
        const gradient = a[10] !== undefined || typeof a[2] === 'number';
        if (gradient && typeof a[2] === 'number') {
          const g = this.args(n, PINE_OUT_PARAMS.fillGradient, scope, ctx, alias);
          a = [g[0], g[1], undefined, g[6], g[9], undefined, g[8], g[7], g[2], g[3], g[4], g[5]];
        }
        if (gradient) {
          const t = a[10], b = a[11];
          color = PineColors.isColor(t) && PineColors.isColor(b)
            ? PineColors.rgb((t.r + b.r) / 2, (t.g + b.g) / 2, (t.b + b.b) / 2, (t.t + b.t) / 2)
            : PineColors.isColor(t) ? t : b;
        } else {
          color = a[2];
        }
        if (first) {
          const ra = a[0], rb = a[1];
          if (!ra?.__out || !rb?.__out) this.fail('fill() needs two plots or two hlines', n);
          o.a = ra.__out;
          o.b = rb.__out;
          title(a[3]);
          o.color = color === undefined ? 'rgba(33,150,243,0.2)' : css(color);
          o.editable = a[4] !== false;
          o.display = disp(a[7]);
        }
        o.colors[i] = color === undefined ? o.color : css(color);
        return NaN;
      }
      case 'bgcolor':
      case 'barcolor': {
        const a = this.args(n, PINE_OUT_PARAMS[name], scope, ctx, undefined, first ? undefined : [0]);
        if (first) {
          o.offset = Math.trunc(PineBuiltins.num(a[1]) || 0);
          o.editable = a[2] !== false;
          title(a[4]);
          o.display = disp(a[5]);
          if (!o.title || o.title === o.key) o.title = name === 'bgcolor' ? 'Background' : 'Bar colour';
        }
        o.colors[i] = css(a[0]);
        return NaN;
      }
    }
    return NaN;
  }
}

/**
 * The entry point the chart, the editor and the alert monitor use: compile
 * (cached by source) and run.
 */
const PineEngine = (() => {
  const cache = new Map<string, { compiled: PineCompiled | null; error: PineError | null }>();

  function compile(src: string): { compiled: PineCompiled | null; error: PineError | null } {
    const hit = cache.get(src);
    if (hit) return hit;
    let res: { compiled: PineCompiled | null; error: PineError | null };
    try {
      res = { compiled: PineCompiler.compile(src), error: null };
    } catch (e: any) {
      res = { compiled: null, error: e instanceof PineError ? e : new PineError(String(e?.message || e), 0, 0, 'compile') };
    }
    if (cache.size > 50) cache.delete(cache.keys().next().value as string);
    cache.set(src, res);
    return res;
  }

  function run(c: PineCompiled, bars: ChartBar[], params: Record<string, any>, opts: PineRunOptions): PineRunResult {
    return PineRunner.run(c, bars, params, opts);
  }

  /** Default value of every input, by key. */
  function defaults(c: PineCompiled): Record<string, number | boolean | string> {
    const out: Record<string, number | boolean | string> = {};
    for (const i of c.inputs) out[i.key] = i.def;
    return out;
  }

  /** "Error on line 12: …" */
  function describe(e: PineError): string {
    return e.line ? `Line ${e.line}: ${e.message}` : e.message;
  }

  return { compile, run, defaults, describe };
})();
