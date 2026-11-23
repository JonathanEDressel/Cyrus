/*
 * Pine Script lexer. Turns source into tokens with NEWLINE / INDENT / DEDENT
 * markers, joining wrapped lines the way Pine does: a line indented by a
 * non-multiple of four, a line inside open brackets, a line that follows one
 * ending in an operator or comma, and a line that starts with a binary
 * operator all continue the line before.
 */

type PineTokType = 'num' | 'str' | 'color' | 'ident' | 'kw' | 'op' | 'nl' | 'indent' | 'dedent' | 'eof';

interface PineToken {
  t: PineTokType;
  v: string;
  line: number;
  col: number;
  /** For numbers: the value, and whether it was written as an integer. */
  num?: number;
  isInt?: boolean;
}

/** Any error with a source position: syntax, compile or runtime. */
class PineError extends Error {
  constructor(message: string, public line = 0, public col = 0, public kind: 'syntax' | 'compile' | 'runtime' = 'compile') {
    super(message);
  }
}

const PineLexer = (() => {
  const KEYWORDS = new Set([
    'if', 'else', 'for', 'to', 'by', 'in', 'while', 'break', 'continue', 'switch',
    'var', 'varip', 'and', 'or', 'not', 'true', 'false', 'na',
    'import', 'export', 'type', 'method', 'enum',
  ]);

  const OPS = [':=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '=>',
    '+', '-', '*', '/', '%', '<', '>', '=', '?', ':', ',', '(', ')', '[', ']'];

  /** A line ending in one of these continues on the next line. */
  const END_CONT = new Set(['+', '-', '*', '/', '%', '==', '!=', '<', '>', '<=', '>=', '?', ':', ',', '(', '[',
    '=', ':=', '+=', '-=', '*=', '/=', '%=']);
  /** A line starting with one of these continues the line before. */
  const START_CONT = new Set(['*', '/', '%', '==', '!=', '<', '>', '<=', '>=', '?', ':', ')', ']', ',']);

  /** Cut a trailing // comment, ignoring // inside strings. */
  function stripComment(line: string): string {
    let q: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '\\') { i++; continue; }
        if (c === q) q = null;
      } else if (c === '"' || c === "'") {
        q = c;
      } else if (c === '/' && line[i + 1] === '/') {
        return line.slice(0, i);
      }
    }
    return line;
  }

  function indentOf(line: string): number {
    let n = 0;
    for (const c of line) {
      if (c === ' ') n += 1;
      else if (c === '\t') n += 4;
      else break;
    }
    return n;
  }

  function tokenizeLine(text: string, line: number): PineToken[] {
    const out: PineToken[] = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      const col = i + 1;
      // Numbers: 12, 1.5, .5, 1e-3
      const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (num && (/\d/.test(c) || (c === '.' && /\d/.test(text[i + 1] || '')))) {
        const s = num[0];
        out.push({ t: 'num', v: s, line, col, num: Number(s), isInt: !/[.eE]/.test(s) });
        i += s.length;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1, s = '';
        while (j < text.length && text[j] !== c) {
          if (text[j] === '\\' && j + 1 < text.length) {
            const e = text[j + 1];
            s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
            j += 2;
          } else {
            s += text[j++];
          }
        }
        if (j >= text.length) throw new PineError('Unterminated string', line, col, 'syntax');
        out.push({ t: 'str', v: s, line, col });
        i = j + 1;
        continue;
      }
      if (c === '#') {
        const m = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?(?![0-9a-zA-Z_])/.exec(text.slice(i));
        if (!m) throw new PineError(`Bad colour literal`, line, col, 'syntax');
        out.push({ t: 'color', v: m[0], line, col });
        i += m[0].length;
        continue;
      }
      const id = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(i));
      if (id) {
        const s = id[0];
        out.push({ t: !s.includes('.') && KEYWORDS.has(s) ? 'kw' : 'ident', v: s, line, col });
        i += s.length;
        continue;
      }
      const op = OPS.find((o) => text.startsWith(o, i));
      if (op) {
        out.push({ t: 'op', v: op, line, col });
        i += op.length;
        continue;
      }
      throw new PineError(`Unexpected character '${c}'`, line, col, 'syntax');
    }
    return out;
  }

  function depth(toks: PineToken[]): number {
    let d = 0;
    for (const t of toks) {
      if (t.t !== 'op') continue;
      if (t.v === '(' || t.v === '[') d++;
      else if (t.v === ')' || t.v === ']') d--;
    }
    return d;
  }

  function endsOpen(toks: PineToken[]): boolean {
    const last = toks[toks.length - 1];
    if (!last) return false;
    if (last.t === 'op') return END_CONT.has(last.v);
    return last.t === 'kw' && (last.v === 'and' || last.v === 'or' || last.v === 'not');
  }

  function startsOpen(toks: PineToken[]): boolean {
    const first = toks[0];
    if (!first) return false;
    if (first.t === 'op') return START_CONT.has(first.v);
    return first.t === 'kw' && (first.v === 'and' || first.v === 'or');
  }

  /** The script's `//@version=N`, or null when it has none. */
  function version(src: string): number | null {
    const m = /^[ \t]*\/\/[ \t]*@version[ \t]*=[ \t]*(\d+)/m.exec(src);
    return m ? Number(m[1]) : null;
  }

  function lex(src: string): PineToken[] {
    const lines = src.split(/\r?\n/);
    const logical: { indent: number; toks: PineToken[] }[] = [];
    let cur: { indent: number; toks: PineToken[] } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const text = stripComment(lines[i]);
      if (!text.trim()) continue;
      const indent = indentOf(text);
      const toks = tokenizeLine(text, i + 1);
      if (cur && (depth(cur.toks) > 0 || indent % 4 !== 0 || endsOpen(cur.toks) || startsOpen(toks))) {
        cur.toks.push(...toks);
      } else {
        if (cur) logical.push(cur);
        cur = { indent, toks };
      }
    }
    if (cur) logical.push(cur);

    const out: PineToken[] = [];
    const stack = [0];
    for (const l of logical) {
      const first = l.toks[0];
      if (l.indent > stack[stack.length - 1]) {
        stack.push(l.indent);
        out.push({ t: 'indent', v: '', line: first.line, col: 1 });
      } else {
        while (l.indent < stack[stack.length - 1]) {
          stack.pop();
          out.push({ t: 'dedent', v: '', line: first.line, col: 1 });
        }
        if (l.indent !== stack[stack.length - 1]) {
          throw new PineError('Indentation doesn\'t line up with any block above', first.line, 1, 'syntax');
        }
      }
      out.push(...l.toks);
      const last = l.toks[l.toks.length - 1];
      out.push({ t: 'nl', v: '', line: last.line, col: last.col + last.v.length });
    }
    const endLine = lines.length;
    while (stack.length > 1) {
      stack.pop();
      out.push({ t: 'dedent', v: '', line: endLine, col: 1 });
    }
    out.push({ t: 'eof', v: '', line: endLine, col: 1 });
    return out;
  }

  return { lex, version, KEYWORDS };
})();
