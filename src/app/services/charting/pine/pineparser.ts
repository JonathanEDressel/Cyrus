/*
 * Pine Script parser: tokens to an AST. Every node carries its source line
 * and column, and a numeric id that the runtime uses to key per-call-site
 * state (each ta.ema() call keeps its own running value).
 */

type PineNodeKind =
  | 'num' | 'str' | 'bool' | 'na' | 'color' | 'name' | 'hist' | 'unary' | 'bin' | 'tern' | 'call' | 'tuple'
  | 'if' | 'switch' | 'for' | 'forin' | 'while'
  | 'decl' | 'tdecl' | 'assign' | 'expr' | 'func' | 'break' | 'continue';

interface PN {
  k: PineNodeKind;
  id: number;
  line: number;
  col: number;
  [field: string]: any;
}

interface PineArg { name: string | null; value: PN; }

class PineParser {
  private pos = 0;
  private nextId = 1;
  /** True when the expression just parsed ended with an indented block. */
  private endedWithBlock = false;

  static readonly TYPE_NAMES = new Set(['int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table',
    'array', 'matrix', 'map', 'linefill', 'polyline', 'chart.point']);
  static readonly QUALIFIERS = new Set(['series', 'simple', 'const', 'input']);

  constructor(private toks: PineToken[]) {}

  static parse(src: string): PN[] {
    return new PineParser(PineLexer.lex(src)).program();
  }

  // ── Token helpers ───────────────────────────────────────────────────────

  private peek(o = 0): PineToken { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  private next(): PineToken { return this.toks[this.pos++]; }
  private is(t: PineTokType, v?: string, o = 0): boolean {
    const k = this.peek(o);
    return k.t === t && (v === undefined || k.v === v);
  }
  private isOp(v: string, o = 0): boolean { return this.is('op', v, o); }
  private isKw(v: string, o = 0): boolean { return this.is('kw', v, o); }

  private fail(msg: string, tok = this.peek()): never {
    throw new PineError(msg, tok.line, tok.col, 'syntax');
  }

  private describe(tok: PineToken): string {
    switch (tok.t) {
      case 'nl': return 'end of line';
      case 'eof': return 'end of script';
      case 'indent': return 'an indented line';
      case 'dedent': return 'the end of the block';
      case 'str': return `"${tok.v}"`;
      default: return `'${tok.v}'`;
    }
  }

  private expectOp(v: string): PineToken {
    if (!this.isOp(v)) this.fail(`Expected '${v}' but found ${this.describe(this.peek())}`);
    return this.next();
  }

  private node(k: PineNodeKind, tok: PineToken, fields: Record<string, any> = {}): PN {
    return { k, id: this.nextId++, line: tok.line, col: tok.col, ...fields };
  }

  // ── Statements ─────────────────────────────────────────────────────────

  program(): PN[] {
    const out: PN[] = [];
    while (!this.is('eof')) {
      if (this.is('nl')) { this.next(); continue; }
      if (this.is('indent')) this.fail('Unexpected indentation');
      if (this.is('dedent')) { this.next(); continue; }
      out.push(...this.statementLine());
    }
    return out;
  }

  private block(): PN[] {
    if (!this.is('indent')) this.fail(`Expected an indented block but found ${this.describe(this.peek())}`);
    this.next();
    const out: PN[] = [];
    while (!this.is('dedent') && !this.is('eof')) {
      if (this.is('nl')) { this.next(); continue; }
      out.push(...this.statementLine());
    }
    if (this.is('dedent')) this.next();
    if (!out.length) this.fail('Empty block');
    return out;
  }

  /** One line's statements (several can share a line, separated by commas). */
  private statementLine(): PN[] {
    const out = [this.statement()];
    while (!this.endedWithBlock && this.isOp(',')) {
      this.next();
      out.push(this.statement());
    }
    this.endLine();
    return out;
  }

  private endLine(): void {
    if (this.endedWithBlock) { this.endedWithBlock = false; return; }
    if (this.is('nl')) { this.next(); return; }
    if (this.is('eof') || this.is('dedent')) return;
    this.fail(`Unexpected ${this.describe(this.peek())}`);
  }

  private statement(): PN {
    this.endedWithBlock = false;
    const t = this.peek();
    if (t.t === 'kw') {
      switch (t.v) {
        case 'import': this.fail('Libraries (import) aren\'t supported yet');
        case 'export': this.fail('export is only for libraries, which aren\'t supported');
        case 'type': this.fail('User-defined types (type) aren\'t supported yet');
        case 'enum': this.fail('Enums (enum) aren\'t supported yet');
        case 'method': this.fail('User-defined methods (method) aren\'t supported yet');
        case 'break': this.next(); return this.node('break', t);
        case 'continue': this.next(); return this.node('continue', t);
      }
    }
    if (t.t === 'ident' && !t.v.includes('.') && this.isOp('(', 1) && this.isFuncDef()) return this.funcDef();
    if (t.t === 'op' && t.v === '[') {
      const td = this.tryTupleDecl();
      if (td) return td;
    }
    const decl = this.tryDecl();
    if (decl) return decl;
    if (t.t === 'ident' && this.is('op', undefined, 1) && [':=', '+=', '-=', '*=', '/=', '%='].includes(this.peek(1).v)) {
      if (t.v.includes('.')) this.fail(`Can't assign to '${t.v}'`);
      this.next();
      const op = this.next().v;
      const value = this.expression();
      return this.node('assign', t, { name: t.v, op, value });
    }
    if (t.t === 'ident' && this.isOp('=', 1) && t.v.includes('.')) this.fail(`'${t.v}' isn't a valid variable name`);
    const e = this.expression();
    return this.node('expr', t, { e });
  }

  /** `name(params) =>`: scan to the matching paren and look for =>. */
  private isFuncDef(): boolean {
    let d = 0;
    for (let i = this.pos + 1; i < this.toks.length; i++) {
      const k = this.toks[i];
      if (k.t === 'nl' || k.t === 'eof') return false;
      if (k.t !== 'op') continue;
      if (k.v === '(' || k.v === '[') d++;
      else if (k.v === ')' || k.v === ']') {
        d--;
        if (d === 0) return this.toks[i + 1]?.t === 'op' && this.toks[i + 1].v === '=>';
      }
    }
    return false;
  }

  private funcDef(): PN {
    const nameTok = this.next();
    this.expectOp('(');
    const params: { name: string; def: PN | null }[] = [];
    while (!this.isOp(')')) {
      // Optional qualifier and type: `simple int len = 14`, `float[] xs`.
      while (this.is('ident') && PineParser.QUALIFIERS.has(this.peek().v) && this.is('ident', undefined, 1)) this.next();
      if (this.is('ident') && PineParser.TYPE_NAMES.has(this.peek().v) &&
          (this.is('ident', undefined, 1) || this.isOp('<', 1) || this.isOp('[', 1))) this.skipType();
      const p = this.next();
      if (p.t !== 'ident' || p.v.includes('.')) this.fail('Expected a parameter name', p);
      let def: PN | null = null;
      if (this.isOp('=')) { this.next(); def = this.expression(); }
      params.push({ name: p.v, def });
      if (this.isOp(',')) this.next();
      else if (!this.isOp(')')) this.fail(`Expected ',' or ')' in the parameter list`);
    }
    this.next();
    this.expectOp('=>');
    let body: PN[];
    if (this.is('nl')) {
      this.next();
      body = this.block();
      this.endedWithBlock = true;
    } else {
      body = [this.statement()];
    }
    return this.node('func', nameTok, { name: nameTok.v, params, body });
  }

  private skipType(): void {
    this.next();
    if (this.isOp('<')) {
      let d = 0;
      do {
        const k = this.next();
        if (k.t === 'op' && k.v === '<') d++;
        else if (k.t === 'op' && k.v === '>') d--;
        else if (k.t === 'nl' || k.t === 'eof') this.fail('Unclosed type arguments');
      } while (d > 0);
    }
    if (this.isOp('[') && this.isOp(']', 1)) { this.next(); this.next(); }
  }

  private tryTupleDecl(): PN | null {
    const save = this.pos;
    const t = this.next();
    const names: string[] = [];
    while (true) {
      const k = this.next();
      if (k.t !== 'ident' || k.v.includes('.')) { this.pos = save; return null; }
      names.push(k.v);
      if (this.isOp(',')) { this.next(); continue; }
      if (this.isOp(']')) { this.next(); break; }
      this.pos = save;
      return null;
    }
    if (!this.isOp('=')) { this.pos = save; return null; }
    this.next();
    const value = this.expression();
    return this.node('tdecl', t, { names, value });
  }

  /** `[var|varip] [qualifier] [type] name = value`, or null if this isn't one. */
  private tryDecl(): PN | null {
    const save = this.pos;
    const first = this.peek();
    let mode = '';
    if (this.isKw('var') || this.isKw('varip')) mode = this.next().v;
    while (this.is('ident') && PineParser.QUALIFIERS.has(this.peek().v) && this.is('ident', undefined, 1)) this.next();
    let typeName: string | null = null;
    if (this.is('ident') && PineParser.TYPE_NAMES.has(this.peek().v) &&
        (this.is('ident', undefined, 1) || this.isOp('<', 1) || (this.isOp('[', 1) && this.isOp(']', 2)))) {
      typeName = this.peek().v;
      this.skipType();
    }
    const name = this.peek();
    if (name.t === 'ident' && !name.v.includes('.') && this.isOp('=', 1)) {
      this.next();
      this.next();
      const value = this.expression();
      return this.node('decl', first, { name: name.v, mode, typeName, value });
    }
    if (mode) this.fail(`Expected 'name = value' after '${mode}'`, name);
    this.pos = save;
    return null;
  }

  // ── Expressions ────────────────────────────────────────────────────────

  expression(): PN {
    this.endedWithBlock = false;
    return this.ternary();
  }

  private ternary(): PN {
    const cond = this.orExpr();
    if (this.endedWithBlock || !this.isOp('?')) return cond;
    const t = this.next();
    const a = this.ternary();
    this.expectOp(':');
    const b = this.ternary();
    return this.node('tern', t, { cond, a, b });
  }

  private binary(next: () => PN, ops: string[], kw = false): PN {
    let l = next();
    while (!this.endedWithBlock && (kw ? ops.some((o) => this.isKw(o)) : ops.some((o) => this.isOp(o)))) {
      const t = this.next();
      const r = next();
      l = this.node('bin', t, { op: t.v, l, r });
    }
    return l;
  }

  private orExpr(): PN { return this.binary(() => this.andExpr(), ['or'], true); }
  private andExpr(): PN { return this.binary(() => this.eqExpr(), ['and'], true); }
  private eqExpr(): PN { return this.binary(() => this.relExpr(), ['==', '!=']); }
  private relExpr(): PN { return this.binary(() => this.addExpr(), ['<', '>', '<=', '>=']); }
  private addExpr(): PN { return this.binary(() => this.mulExpr(), ['+', '-']); }
  private mulExpr(): PN { return this.binary(() => this.unary(), ['*', '/', '%']); }

  private unary(): PN {
    const t = this.peek();
    if ((t.t === 'op' && (t.v === '-' || t.v === '+')) || (t.t === 'kw' && t.v === 'not')) {
      this.next();
      return this.node('unary', t, { op: t.v, e: this.unary() });
    }
    return this.postfix();
  }

  private postfix(): PN {
    let e = this.primary();
    while (this.isOp('[') && !this.endedWithBlock) {
      const t = this.next();
      const off = this.expression();
      this.expectOp(']');
      e = this.node('hist', t, { e, off });
    }
    return e;
  }

  private primary(): PN {
    const t = this.peek();
    switch (t.t) {
      case 'num': this.next(); return this.node('num', t, { v: t.num, isInt: t.isInt });
      case 'str': this.next(); return this.node('str', t, { v: t.v });
      case 'color': {
        this.next();
        return this.node('color', t, { v: PineColors.hex(t.v) });
      }
      case 'kw':
        switch (t.v) {
          case 'true': case 'false': this.next(); return this.node('bool', t, { v: t.v === 'true' });
          case 'na':
            this.next();
            if (this.isOp('(')) return this.call(t, 'na');
            return this.node('na', t);
          case 'if': return this.ifExpr();
          case 'switch': return this.switchExpr();
          case 'for': return this.forExpr();
          case 'while': return this.whileExpr();
        }
        this.fail(`Unexpected '${t.v}'`);
      case 'ident': {
        this.next();
        let typeArgs: string | null = null;
        if (this.isOp('<') && /(^|\.)new$/.test(t.v)) {
          // array.new<float>(...)
          const start = this.pos;
          this.pos--;
          this.skipType();
          typeArgs = this.toks.slice(start + 1, this.pos - 1).map((k) => k.v).join('');
        }
        if (this.isOp('(')) return this.call(t, t.v, typeArgs);
        return this.node('name', t, { name: t.v });
      }
      case 'op':
        if (t.v === '(') {
          this.next();
          const e = this.expression();
          this.expectOp(')');
          return e;
        }
        if (t.v === '[') {
          this.next();
          const items: PN[] = [];
          while (!this.isOp(']')) {
            items.push(this.expression());
            if (this.isOp(',')) this.next();
            else if (!this.isOp(']')) this.fail(`Expected ',' or ']'`);
          }
          this.next();
          return this.node('tuple', t, { items });
        }
    }
    this.fail(`Unexpected ${this.describe(t)}`);
  }

  private call(t: PineToken, name: string, typeArgs: string | null = null): PN {
    this.expectOp('(');
    const args: PineArg[] = [];
    while (!this.isOp(')')) {
      if (this.is('ident') && !this.peek().v.includes('.') && this.isOp('=', 1)) {
        const n = this.next().v;
        this.next();
        args.push({ name: n, value: this.expression() });
      } else {
        if (args.some((a) => a.name)) this.fail('Positional arguments must come before named ones');
        args.push({ name: null, value: this.expression() });
      }
      if (this.isOp(',')) this.next();
      else if (!this.isOp(')')) this.fail(`Expected ',' or ')' but found ${this.describe(this.peek())}`);
    }
    this.next();
    return this.node('call', t, { name, args, typeArgs });
  }

  /** The body after `if cond` / `for ...` etc: an indented block. */
  private blockAfterHeader(): PN[] {
    if (!this.is('nl')) this.fail(`Expected end of line but found ${this.describe(this.peek())}`);
    this.next();
    return this.block();
  }

  private ifExpr(): PN {
    const t = this.next();
    const cond = this.expression();
    const then = this.blockAfterHeader();
    const elifs: { cond: PN; body: PN[] }[] = [];
    let otherwise: PN[] | null = null;
    while (this.isKw('else')) {
      this.next();
      if (this.isKw('if')) {
        this.next();
        const c = this.expression();
        elifs.push({ cond: c, body: this.blockAfterHeader() });
        continue;
      }
      otherwise = this.blockAfterHeader();
      break;
    }
    this.endedWithBlock = true;
    return this.node('if', t, { cond, then, elifs, otherwise });
  }

  private switchExpr(): PN {
    const t = this.next();
    const subject = this.is('nl') ? null : this.expression();
    if (!this.is('nl')) this.fail('Expected end of line after switch');
    this.next();
    if (!this.is('indent')) this.fail('Expected the switch cases on indented lines');
    this.next();
    const cases: { cond: PN | null; body: PN[] }[] = [];
    while (!this.is('dedent') && !this.is('eof')) {
      if (this.is('nl')) { this.next(); continue; }
      let cond: PN | null = null;
      if (!this.isOp('=>')) cond = this.expression();
      this.expectOp('=>');
      let body: PN[];
      if (this.is('nl')) {
        this.next();
        body = this.block();
      } else {
        body = [this.statement()];
        if (this.endedWithBlock) this.endedWithBlock = false;
        else if (this.is('nl')) this.next();
      }
      cases.push({ cond, body });
    }
    if (this.is('dedent')) this.next();
    this.endedWithBlock = true;
    return this.node('switch', t, { subject, cases });
  }

  private forExpr(): PN {
    const t = this.next();
    if (this.isOp('[')) {
      this.next();
      const idx = this.next();
      this.expectOp(',');
      const item = this.next();
      this.expectOp(']');
      if (!this.isKw('in')) this.fail(`Expected 'in'`);
      this.next();
      const coll = this.expression();
      const body = this.blockAfterHeader();
      this.endedWithBlock = true;
      return this.node('forin', t, { idx: idx.v, item: item.v, coll, body });
    }
    const v = this.next();
    if (v.t !== 'ident' || v.v.includes('.')) this.fail('Expected a loop variable', v);
    if (this.isKw('in')) {
      this.next();
      const coll = this.expression();
      const body = this.blockAfterHeader();
      this.endedWithBlock = true;
      return this.node('forin', t, { idx: null, item: v.v, coll, body });
    }
    this.expectOp('=');
    const from = this.expression();
    if (!this.isKw('to')) this.fail(`Expected 'to' in the for loop`);
    this.next();
    const to = this.expression();
    let step: PN | null = null;
    if (this.isKw('by')) { this.next(); step = this.expression(); }
    const body = this.blockAfterHeader();
    this.endedWithBlock = true;
    return this.node('for', t, { v: v.v, from, to, step, body });
  }

  private whileExpr(): PN {
    const t = this.next();
    const cond = this.expression();
    const body = this.blockAfterHeader();
    this.endedWithBlock = true;
    return this.node('while', t, { cond, body });
  }
}
