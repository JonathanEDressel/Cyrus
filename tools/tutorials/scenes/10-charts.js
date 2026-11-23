// Charts — the charting workspace: symbols (crypto and stocks), timeframes,
// chart types, drawing tools, price alerts from a line, indicators, Compare,
// the Pine Editor, saving, and the My trades overlay.
//
// Demo-mode notes that the narration relies on:
//   - The page opens the seeded saved chart "BTC vs ETH · 4H levels" (Kraken,
//     BTC/USD over ETH/USD, a fib, a channel and a line, EMA 21 and RSI 14).
//     DemoData.chartStore in src/app/services/demomode.ts.
//   - New chart starts on the symbol and source on screen (BTC/USD, Kraken).
//   - The chart sources are Coinbase Advanced, Kraken and Stocks; Stocks is
//     already "configured", with 8 tickers (AAPL ... QQQ). In the real app
//     KuCoin is a source too, which the narration mentions while the native
//     select is closed.
//   - Price alerts are kept in memory and never fire in demo mode.
//   - The Pine Editor's Add to chart saves the script through IndicatorData,
//     which demo mode does not stub, so it lands in the harness's throwaway
//     database.
//   - The camera button is only hovered: it saves a PNG through a file dialog.

const STAGE = '#ct-stage';
const SYM = n => `${STAGE} .cw-sym[data-act="symbol"] >> nth=${n}`;
const PAIR_MODAL = '#ct-pair-overlay .edit-rule-modal';

/** A point inside the chart stage, as fractions of its width and height. */
async function at(h, fx, fy) {
  const r = await h.eval(sel => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, STAGE);
  return { x: Math.round(r.x + r.w * fx), y: Math.round(r.y + r.h * fy) };
}

/** Glide the visible cursor to a chart point and click there. */
async function clickChart(h, fx, fy) {
  const p = await at(h, fx, fy);
  await h.moveXY(p.x, p.y);
  await h.page.mouse.move(p.x, p.y);
  await h.eval(() => window.__tut.press());
  await h.page.mouse.down();
  await h.page.mouse.up();
  await h.wait(250);
}

/** Press, drag and release across the chart (places a two-point tool). */
async function dragChart(h, [fx1, fy1], [fx2, fy2], ms = 1100) {
  const a = await at(h, fx1, fy1);
  const b = await at(h, fx2, fy2);
  await h.moveXY(a.x, a.y);
  await h.page.mouse.move(a.x, a.y);
  await h.eval(() => window.__tut.press());
  await h.page.mouse.down();
  const glide = h.moveXY(b.x, b.y, ms);
  await h.page.mouse.move(b.x, b.y, { steps: 24 });
  await glide;
  await h.page.mouse.up();
  await h.wait(250);
}

module.exports = {
  id: 'charts',
  order: 10,
  title: 'Charts',
  subtitle: 'Chart any coin or US stock, draw on it, compare symbols, and set alerts.',
  summary: 'Symbols and timeframes for crypto and stocks, chart types, drawing tools, price alerts from a line, indicators, Compare, the Pine Editor, saving charts, and your own trades on the chart.',
  setup: async h => { await h.nav('charts'); await h.settle(1500); },
  steps: [
    {
      chapter: 'Introduction',
      say: "This is Charts. You can chart any coin or US stock, draw on it, add indicators, stack symbols to compare them, and save your charts to come back to.",
      act: async h => { await h.spot('.charts-header'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "Cyrus opens the chart you had last. This demo starts on a saved chart: Bitcoin over Ethereum, on four hour candles, with a few lines already drawn and two indicators.",
      act: async h => {
        await h.spot(STAGE);
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      chapter: 'Symbols and timeframes',
      say: "Let's start a fresh one. Open the chart menu, and click New chart.",
      act: async h => {
        await h.click('#ct-chart-btn');
        await h.wait(700);
        await h.click('#ct-chart-menu [data-chart-act="new"]');
        await h.settle(1000);
      },
    },
    {
      say: "A new chart starts on the symbol you were looking at. To change it, click the symbol's name at the top of the chart.",
      act: async h => {
        await h.click(SYM(0));
        await h.wait(700);
        await h.spot(PAIR_MODAL);
        await h.wait(1200);
        await h.spot(null);
      },
    },
    {
      say: "First pick where the prices come from. Crypto works out of the box, from Coinbase, Kraken or KuCoin. Coinbase is the default, and it loads older candles as you scroll back.",
      act: async h => {
        await h.select('#ct-pair-source', 'coinbase');
        await h.wait(600);
        await h.spot('#ct-pair-hint');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Stocks covers US stocks and ETFs. It uses your own free market data key from Alpaca, which you add once on your Profile, under Exchanges. Prices are real time, and volume counts trades on one exchange, called IEX.",
      act: async h => {
        await h.select('#ct-pair-source', 'stocks');
        await h.wait(700);
        await h.spot('#ct-pair-hint');
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "You can search by ticker or by company name. Type apple, and pick Apple.",
      act: async h => {
        await h.type('#ct-pair-search', 'apple', { delay: 90 });
        await h.wait(700);
        await h.click('#ct-pair-list [data-symbol="AAPL"]');
        await h.settle(1200);
      },
    },
    {
      say: "The buttons along the top set the timeframe, from one minute candles up to one week. Here's the daily chart, and then back to hourly.",
      act: async h => {
        await h.spot('#ct-timeframes');
        await h.click('#ct-timeframes [data-tf="1d"]');
        await h.wait(1600);
        await h.click('#ct-timeframes [data-tf="1h"]');
        await h.wait(800);
        await h.spot(null);
      },
    },
    {
      chapter: 'Chart types',
      say: "The chart type menu draws the price as candles, bars, a line, or a filled area.",
      act: async h => {
        await h.select('#ct-type', 'line');
        await h.wait(1200);
        await h.select('#ct-type', 'area');
        await h.wait(1200);
        await h.select('#ct-type', 'candles');
        await h.wait(500);
      },
    },
    {
      chapter: 'Drawing tools',
      say: "The drawing tools run down the left side: lines and rays, channels, a fib retracement, volume profiles, anchored VWAP, rectangles, a price range ruler, and text notes. The buttons at the bottom hide, lock, or clear every drawing at once.",
      act: async h => { await h.spot('#ct-tools'); await h.wait(4000); await h.spot(null); },
    },
    {
      say: "Pick the trend line, then press and drag across the chart. Turn on the magnet first, and each end snaps to a nearby candle's open, high, low or close.",
      act: async h => {
        await h.click('#ct-tools [data-toggle="magnet"]');
        await h.wait(400);
        await h.click('#ct-tools [data-tool="trend"]');
        await h.wait(300);
        await dragChart(h, [0.22, 0.68], [0.62, 0.5]);
        await h.wait(600);
      },
    },
    {
      say: "A new drawing stays selected, and a style bar appears for it: its color, thickness, and dashes. You can also lock it, copy it, or delete it.",
      act: async h => {
        await h.spot('#ct-stylebar');
        await h.click('#ct-stylebar [data-style="color"] >> nth=2');
        await h.wait(700);
        await h.click('#ct-stylebar [data-style="width"][data-v="3"]');
        await h.wait(1200);
        await h.spot(null);
      },
    },
    {
      say: "Made a mistake? Undo and redo, at the top right, step back and forward through your changes. Control Z works too.",
      act: async h => {
        await h.click('#ct-undo');
        await h.wait(700);
        await h.click('#ct-undo');
        await h.wait(700);
        await h.click('#ct-redo');
        await h.wait(700);
        await h.click('#ct-redo');
        await h.wait(500);
      },
    },
    {
      chapter: 'Price alerts',
      say: "Now a horizontal line. Turn the magnet off, pick the tool, and click once at the price you care about.",
      act: async h => {
        await h.click('#ct-tools [data-toggle="magnet"]');
        await h.wait(300);
        await h.click('#ct-tools [data-tool="hline"]');
        await h.wait(300);
        await clickChart(h, 0.5, 0.66);
        await h.wait(600);
      },
    },
    {
      say: "Horizontal lines and trend lines can carry an alert. Click the bell, and Cyrus tells you when the price reaches the line. On a trend line, the alert follows the slope.",
      act: async h => {
        await h.hover('#ct-stylebar [data-style="alert"]');
        await h.wait(600);
        await h.click('#ct-stylebar [data-style="alert"]');
        await h.wait(1500);
      },
    },
    {
      say: "Alerts work on stocks and crypto alike. Cyrus checks them about once a minute while it's running, and shows a desktop notification when one fires, plus an email if you've set email up on your Profile.",
    },
    {
      say: "The Alerts button lists them all. A fired alert switches off until you move its line or re-arm it, and moving or deleting the line takes the alert along with it.",
      act: async h => {
        await h.click('#ct-alerts-btn');
        await h.wait(600);
        await h.spot('#ct-alerts-menu');
        await h.wait(3500);
        await h.spot(null);
        // Escape closes the list and deselects the line, hiding its style bar.
        await h.press('Escape');
        await h.wait(300);
      },
    },
    {
      chapter: 'Indicators',
      say: "Indicators adds moving averages, Bollinger Bands, R S I, MACD, and a long list of volume studies. Each one is marked as drawing on the price, or in its own pane.",
      act: async h => {
        await h.click('#ct-indicators');
        await h.wait(700);
        await h.spot('#ct-ind-menu');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Let's add Bollinger Bands. Its label appears at the top of the chart. Click the name or the gear to change its settings and color, or the cross to remove it.",
      act: async h => {
        await h.click('#ct-ind-menu [data-ind-type="bb"]');
        await h.settle(900);
        await h.hover(`${STAGE} .cw-chip-name >> nth=0`);
        await h.wait(1200);
        await h.hover(`${STAGE} .cw-chip-btn[data-act="ind-edit"] >> nth=0`);
        await h.wait(900);
      },
    },
    {
      chapter: 'Comparing symbols',
      say: "Compare adds another symbol to the same chart, up to four symbols in all. Let's put Microsoft under Apple.",
      act: async h => {
        await h.click('#ct-compare');
        await h.wait(700);
        await h.type('#ct-pair-search', 'msft', { delay: 90 });
        await h.wait(600);
        await h.click('#ct-pair-list [data-symbol="MSFT"]');
        await h.settle(1200);
      },
    },
    {
      say: "Each symbol gets its own pane, and they share one time axis, so you can line moves up. Any pane can come from a different source, and the cross in its header removes it.",
      act: async h => { await h.spot(STAGE); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "With two or more symbols, a new menu appears. Overlay in percent puts them on one chart, each measured as a percent change, so you can see which did better. Price overlays like the bands step aside in this mode.",
      act: async h => {
        await h.select('#ct-compare-mode', 'percent');
        await h.wait(800);
        await h.spot(STAGE);
        await h.wait(3000);
        await h.spot(null);
        await h.select('#ct-compare-mode', 'stacked');
        await h.wait(500);
      },
    },
    {
      chapter: 'Pine Editor',
      say: "For your own indicators, open the Pine Editor. It's docked under the chart, and takes scripts written in Pine Script, the language TradingView uses. A new script starts from a simple example.",
      act: async h => {
        await h.click('#ct-pine');
        await h.settle(900);
        await h.spot('#ct-editor');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Errors show up underneath as you type. Add to chart saves the script to your indicators, and draws it.",
      act: async h => {
        await h.hover('#ct-editor .pe-console');
        await h.wait(800);
        await h.click('#ct-editor [data-pe="add"]');
        await h.settle(1500);
      },
    },
    {
      say: "If a script has alert conditions, its label gets a bell too, so you can be alerted when a condition comes true. Close the editor with the cross.",
      act: async h => {
        await h.hover(`${STAGE} .cw-chip-btn[data-act="ind-alert"]`);
        await h.wait(1800);
        await h.click('#ct-editor [data-pe="close"]');
        await h.settle(800);
        await h.scroll(-3000, { ms: 700 });
      },
    },
    {
      chapter: 'Saving charts',
      say: "The dot next to the chart's name means it has unsaved changes. Cyrus keeps them even if you switch to another chart, until you save or discard them.",
      act: async h => { await h.spot('#ct-chart-btn'); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "Click Save, or press Control S. A new chart asks for a name, and suggests one from its symbols and timeframe.",
      act: async h => {
        await h.click('#ct-save');
        await h.wait(700);
        await h.spot('#ct-name-overlay .edit-rule-modal');
        await h.wait(2000);
        await h.spot(null);
        await h.click('#ct-name-ok');
        await h.settle(800);
      },
    },
    {
      say: "A saved chart keeps its symbols, drawings, indicators and timeframe. The chart menu lists them all, and also starts a new chart, saves a copy, renames, or deletes. Let's go back to the Bitcoin chart.",
      act: async h => {
        await h.click('#ct-chart-btn');
        await h.wait(700);
        await h.spot('#ct-chart-menu');
        await h.wait(2500);
        await h.spot(null);
        await h.click('#ct-chart-list [data-chart-id="1"]');
        await h.settle(1500);
      },
    },
    {
      chapter: 'My trades',
      say: "On a crypto chart, My trades shows your own activity. Dashed lines mark your open orders, with the side, the amount left, and the account. Arrows mark past buys and sells.",
      act: async h => {
        await h.spot(`${STAGE}`);
        await h.wait(4000);
        await h.spot(null);
      },
    },
    {
      say: "If your average cost is in view, a solid line marks it too. The button turns it all off and on. Stock charts don't show any of this, because Cyrus doesn't trade stocks.",
      act: async h => {
        await h.click('#ct-mine');
        await h.wait(1500);
        await h.click('#ct-mine');
        await h.wait(800);
      },
    },
    {
      chapter: 'Wrapping up',
      say: "The camera button saves a picture of the chart, with its name and symbols across the top.",
      act: async h => { await h.hover('#ct-shot'); await h.spot('#ct-shot'); await h.wait(2000); await h.spot(null); },
    },
    {
      say: "That's Charts: pick a coin or stock, mark it up, set alerts on the lines that matter, and save it for next time.",
      act: async h => { await h.spot('.charts-header'); await h.wait(2500); await h.spot(null); },
    },
  ],
};
