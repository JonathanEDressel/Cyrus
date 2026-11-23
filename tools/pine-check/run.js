#!/usr/bin/env node
/*
 * Checks the Pine Script interpreter outside the app.
 *
 *   npm run build && node tools/pine-check/run.js [script.pine ...]
 *
 * Loads the compiled interpreter into one vm context (the files share globals
 * there the way they do in the browser), then runs:
 *   1. parity: Pine versions of built-in indicators against ChartIndicators
 *   2. a corpus of small scripts covering the language
 *   3. error cases (unsupported features, v4, runaway loops)
 *   4. any scripts named on the command line (compile + run summary)
 *
 * Bars are a seeded random walk, so runs are repeatable without network or
 * fixture files.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const FILES = [
  'charting/chartgeometry.js',
  'charting/chartindicators.js',
  'charting/pine/pinecolor.js',
  'charting/pine/pinelexer.js',
  'charting/pine/pineparser.js',
  'charting/pine/pinecompile.js',
  'charting/pine/pinebuiltins.js',
  'charting/pine/pineruntime.js',
].map((f) => path.join(root, 'dist', 'app', 'services', f));

const ctx = vm.createContext({ console, performance, Math, Date });
for (const f of FILES) {
  if (!fs.existsSync(f)) {
    console.error(`Missing ${path.relative(root, f)}: run "npm run build" first.`);
    process.exit(2);
  }
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
}
const g = (expr) => vm.runInContext(expr, ctx);
const PineEngine = g('PineEngine');
const ChartIndicators = g('ChartIndicators');

// ── Bars ────────────────────────────────────────────────────────────────
function makeBars(n, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const bars = [];
  let price = 30000;
  const t0 = Date.UTC(2024, 0, 1) / 1000;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = Math.max(1, open * (1 + (rnd() - 0.5) * 0.02));
    const high = Math.max(open, close) * (1 + rnd() * 0.006);
    const low = Math.min(open, close) * (1 - rnd() * 0.006);
    bars.push({ time: t0 + i * 3600, open, high, low, close, volume: 10 + rnd() * 90 });
    price = close;
  }
  return bars;
}
const BARS = makeBars(1500);
const OPTS = { symbol: 'BTC/USD', source: 'kraken', exchange: 'Kraken', timeframe: '1h', lastLive: false };

// ── Helpers ─────────────────────────────────────────────────────────────
let failed = 0, passed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `: ${detail}` : ''}`);
}

function run(src, params = {}, bars = BARS) {
  const { compiled, error } = PineEngine.compile(src);
  if (error) throw new Error(`compile: ${PineEngine.describe(error)}`);
  const res = PineEngine.run(compiled, bars, params, OPTS);
  if (res.error) throw new Error(`run: ${PineEngine.describe(res.error)}`);
  return { compiled, res };
}

const plots = (res) => res.outputs.filter((o) => o.kind === 'plot');
const near = (a, b, tol = 1e-9) => (isNaN(a) && isNaN(b)) || Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

/** Compare a Pine output to a ChartIndicators line, bar by bar, from `from`. */
function sameAs(name, values, line, from = 0) {
  const byTime = new Map(line.points.map((p) => [p.time, p.value]));
  let bad = null, compared = 0;
  for (let i = from; i < BARS.length; i++) {
    const want = byTime.has(BARS[i].time) ? byTime.get(BARS[i].time) : NaN;
    const got = values[i];
    if (isNaN(want) && isNaN(got)) continue;
    compared++;
    if (!near(got, want)) { bad = `bar ${i}: got ${got}, want ${want}`; break; }
  }
  ok(name, !bad && compared > 100, bad || `only ${compared} bars compared`);
}

const V = '//@version=6\n';

// ── 1. Parity with the built-in indicators ─────────────────────────────
function parity() {
  const builtin = (type, params) => ChartIndicators.get(type).compute(BARS, { ...ChartIndicators.defaults(type), ...params });
  const p = (src) => plots(run(V + 'indicator("t")\n' + src).res);

  sameAs('sma', p('plot(ta.sma(close, 20))')[0].values, builtin('sma', { length: 20 })[0]);
  sameAs('ema', p('plot(ta.ema(close, 21))')[0].values, builtin('ema', { length: 21 })[0]);
  const bb = p('[m, u, l] = ta.bb(close, 20, 2)\nplot(u)\nplot(m)\nplot(l)');
  const bbB = builtin('bb', { length: 20, mult: 2 });
  sameAs('bb upper', bb[0].values, bbB[0]);
  sameAs('bb basis', bb[1].values, bbB[1]);
  sameAs('bb lower', bb[2].values, bbB[2]);
  sameAs('rsi', p('plot(ta.rsi(close, 14))')[0].values, builtin('rsi', { length: 14 })[0]);
  const macd = p('[m, s, h] = ta.macd(close, 12, 26, 9)\nplot(h)\nplot(m)\nplot(s)');
  const macdB = builtin('macd', { fast: 12, slow: 26, signal: 9 });
  sameAs('macd hist', macd[0].values, macdB[0]);
  sameAs('macd line', macd[1].values, macdB[1]);
  sameAs('macd signal', macd[2].values, macdB[2]);
  sameAs('vwma', p('plot(ta.vwma(close, 20))')[0].values, builtin('vwma', { length: 20 })[0]);
  sameAs('obv', p('plot(ta.obv)')[0].values, builtin('obv', {})[0]);
  sameAs('cmf', p('mfm = high > low ? ((close - low) - (high - close)) / (high - low) : 0\nplot(math.sum(mfm * volume, 20) / math.sum(volume, 20))')[0].values, builtin('cmf', { length: 20 })[0]);
  sameAs('mfi', p('plot(ta.mfi(hlc3, 14))')[0].values, builtin('mfi', { length: 14 })[0], 30);
  sameAs('ad', p('plot(ta.accdist)')[0].values, builtin('ad', {})[0]);
}

// ── 2. Language corpus ─────────────────────────────────────────────────
function corpus() {
  {
    const [count, x, c3] = plots(run(V + `indicator("history")
var int count = 0
count := count + 1
x = 0
x := nz(x[1]) + 2
plot(count)
plot(x)
plot(close[3])`).res);
    ok('var counts bars', count.values[0] === 1 && count.values[999] === 1000);
    ok('x[1] reads last bar', x.values[0] === 2 && x.values[9] === 20);
    ok('close[3]', isNaN(c3.values[2]) && c3.values[10] === BARS[7].close);
  }
  {
    const [a, b] = plots(run(V + `indicator("fn state")
f(src) => ta.sma(src, 3)
a = f(close)
b = f(open)
plot(a)
plot(b)`).res);
    const sma3 = (k, i) => (BARS[i][k] + BARS[i - 1][k] + BARS[i - 2][k]) / 3;
    ok('each call site keeps its own ta state', near(a.values[50], sma3('close', 50)) && near(b.values[50], sma3('open', 50)));
  }
  {
    const out = plots(run(V + `indicator("mixed")
g(x) => [x * 2, x + 1]
[p, q] = g(close)
s = switch
    close > open => 1
    close < open => -1
    => 0
sum = 0.0
for i = 0 to 4
    sum += close[i]
k = 0
while k < 3
    k += 1
arr = array.new<float>()
for i = 0 to 2
    array.push(arr, i)
arr.push(10)
t = str.tostring(arr.size()) + "x"
plot(p - close * 2)
plot(q - close)
plot(s)
plot(sum)
plot(k)
plot(array.sum(arr))
plot(str.length(t))`).res);
    const i = 100, b = BARS[i];
    ok('tuple return', near(out[0].values[i], 0) && near(out[1].values[i], 1));
    ok('switch', out[2].values[i] === (b.close > b.open ? 1 : b.close < b.open ? -1 : 0));
    ok('for + history', near(out[3].values[i], [0, 1, 2, 3, 4].reduce((s, k) => s + BARS[i - k].close, 0)));
    ok('while', out[4].values[i] === 3);
    ok('arrays + methods', out[5].values[i] === 13);
    ok('strings', out[6].values[i] === 2);
  }
  {
    const out = plots(run(V + `indicator("layout")
v = close > open ?
     1 :
     -1
w = if close > open
    10
else
    20
y = close > open
     and volume > 0 ? 5 : 6
plot(v)
plot(w)
plot(y)`).res);
    const i = 200, up = BARS[i].close > BARS[i].open;
    ok('wrapped ternary', out[0].values[i] === (up ? 1 : -1));
    ok('if expression', out[1].values[i] === (up ? 10 : 20));
    ok('line starting with and', out[2].values[i] === (up ? 5 : 6));
  }
  {
    const { compiled, res } = run(V + `indicator("inputs", overlay=true)
len = input.int(10, "Length", minval=1)
src = input.source(close, "Source")
show = input.bool(true, "Show")
col = input.color(color.red, "Colour")
mode = input.string("A", "Mode", options=["A", "B"])
plot(show ? ta.sma(src, len) : na, color=col)`, { length: 5, source: 'open' });
    ok('inputs listed', compiled.inputs.map((i) => i.key).join() === 'length,source,show,colour,mode');
    ok('input overrides used', near(plots(res)[0].values[10], [6, 7, 8, 9, 10].reduce((s, k) => s + BARS[k].open, 0) / 5));
    ok('overlay flag', compiled.overlay === true);
  }
  {
    const { res } = run(V + `indicator("outputs")
p1 = plot(close, display=display.none)
p2 = plot(open, color=close > open ? color.lime : na)
h = hline(50)
fill(p1, p2, color=color.new(color.blue, 80))
bgcolor(close > open ? color.new(color.green, 90) : na)
barcolor(close > open ? color.lime : color.red)
plotshape(ta.crossover(close, open), style=shape.triangleup, location=location.belowbar)
alertcondition(close > open, "Up", "Up on {{ticker}}")
var t = table.new(position.top_right, 1, 1)
if barstate.islast
    table.cell(t, 0, 0, "hi", text_color=color.white)`);
    const kinds = res.outputs.map((o) => o.kind).join();
    ok('output kinds', kinds === 'plot,plot,hline,fill,bg,bar,shape', kinds);
    ok('display.none', res.outputs[0].display === 0);
    ok('per-bar colour with na', res.outputs[1].colors.some((c) => c === null) && res.outputs[1].colors.some((c) => c && c.startsWith('rgba(0,230,118')));
    ok('fill refs', res.outputs[3].a === res.outputs[0].key && res.outputs[3].b === res.outputs[1].key);
    ok('alertcondition hits', res.alerts.length === 1 && res.alerts[0].hits.some((h) => h === 1) && res.alerts[0].message === 'Up on {{ticker}}');
    ok('table', res.tables.length === 1 && res.tables[0].cells[0][0].text === 'hi');
  }
}

// ── 3. Errors ──────────────────────────────────────────────────────────
function errors() {
  const compileErr = (src) => PineEngine.compile(src).error;
  const runErr = (src) => {
    const { compiled, error } = PineEngine.compile(src);
    if (error) return error;
    return PineEngine.run(compiled, BARS.slice(0, 50), {}, OPTS).error;
  };
  const e1 = compileErr(V + 'indicator("x")\ny = request.security("BTCUSD", "D", close)\nplot(y)');
  ok('request.security rejected', e1 && /request/.test(e1.message) && e1.line === 3, e1 && e1.message);
  const e2 = compileErr('//@version=4\nstudy("x")\nplot(close)');
  ok('v4 rejected', e2 && /v4/.test(e2.message));
  const e3 = runErr(V + 'indicator("x")\nk = 0\nwhile true\n    k += 1\nplot(k)');
  ok('runaway loop stopped', e3 && /Loop limit|too long/.test(e3.message) && e3.line >= 3, e3 && e3.message);
  const e4 = compileErr(V + 'indicator("x")\nplot(foo(1))');
  ok('unknown function', e4 && /foo/.test(e4.message) && e4.line === 3);
  const e5 = compileErr(V + 'indicator("x")\nif close > open\n    plot(close)');
  ok('plot in local scope', e5 && /local scope/.test(e5.message));
  const e6 = compileErr(V + 'indicator("x")\nplot(close');
  ok('syntax error has a line', e6 && e6.line >= 3, e6 && `${e6.line}: ${e6.message}`);
  const e7 = compileErr(V + 'strategy("x")\nplot(close)');
  ok('strategy rejected', e7 && /Strateg/.test(e7.message));
  const e8 = runErr(V + 'indicator("x")\nplot(zz)');
  ok('undeclared identifier', e8 && /zz/.test(e8.message) && e8.line === 3);
}

// ── 4. Scripts from the command line ───────────────────────────────────
function extra(files) {
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const { compiled, error } = PineEngine.compile(src);
    if (error) { failed++; console.log(`FAIL  ${f}: ${PineEngine.describe(error)}`); continue; }
    const res = PineEngine.run(compiled, BARS, {}, OPTS);
    if (res.error) { failed++; console.log(`FAIL  ${f}: ${PineEngine.describe(res.error)}`); continue; }
    passed++;
    const count = (k) => res.outputs.filter((o) => o.kind === k).length;
    const visible = res.outputs.filter((o) => o.kind === 'plot' && (o.display & 1)).length;
    console.log(`ok    ${path.basename(f)}: "${compiled.shorttitle || compiled.title}" overlay=${compiled.overlay} ` +
      `inputs=${compiled.inputs.length} plots=${count('plot')} (${visible} drawn) fills=${count('fill')} ` +
      `bg=${count('bg')} barcolor=${count('bar')} shapes=${count('shape') + count('char')} hlines=${count('hline')} ` +
      `tables=${res.tables.length} alerts=${res.alerts.length} in ${res.ms.toFixed(1)} ms`);
    for (const o of res.outputs.filter((x) => x.kind === 'plot' && (x.display & 1))) {
      const last = o.values[o.values.length - 1];
      console.log(`        ${o.title}: last=${isNaN(last) ? 'na' : last.toFixed(4)} style=${o.style}`);
    }
    for (const t of res.tables) {
      console.log(`        table @${t.position}: ${t.cells.map((r) => r.map((c) => c ? c.text : '').join(' | ')).join(' / ')}`);
    }
  }
}

const sections = [['parity', parity], ['corpus', corpus], ['errors', errors]];
for (const [name, fn] of sections) {
  try { fn(); } catch (e) { failed++; console.log(`FAIL  ${name} crashed: ${e.stack || e}`); }
}
extra(process.argv.slice(2));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
