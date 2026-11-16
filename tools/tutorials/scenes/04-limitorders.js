// Limit Orders — the resting-order table, the staggered-ladder wizard, the
// background placement job, the two charts, bulk cancel and CSV export.
//
// Demo-mode notes that the narration relies on:
//   - The wizard defaults to the first connection, Main (Kraken), whose demo
//     pacing is 1000 ms per order, so the progress panel is visible for a while.
//   - DemoData.createOrder rejects every 4th placement. An 8-step ladder that
//     alternates USD/USDC therefore places 6 (all four USD steps, USDC steps
//     2 and 6) and rejects 2, which the "rejects two orders on purpose" step
//     describes. Nothing else in the scene places an order before it.
//   - Navigating away and back re-creates the page controller, so the table is
//     back on the Buy tab afterwards; the scene switches to Sell again.
//   - Export CSV is only hovered: in the app it opens a save dialog.

const ROW = n => `#limit-tbody tr.limit-row:nth-child(${n})`;
const PARTIAL_ROW = '#limit-tbody tr.limit-row:has(.limit-partial-tag)';
const SOL_FLOW = '#limit-flow-charts .limit-flow-chart:has(.limit-flow-coin:text-is("SOL"))';

module.exports = {
  id: 'limitorders',
  order: 4,
  title: 'Limit Orders',
  subtitle: 'Watch your resting orders, build staggered ladders, and cancel in bulk.',
  summary: 'The order table, details and cancelling, the three-step ladder wizard with price bands, sizing and shaping, background placement, the order charts, bulk cancel and CSV export.',
  setup: async h => { await h.nav('limitorders'); },
  steps: [
    {
      chapter: 'Introduction',
      say: "This is Limit Orders. It lists every limit order resting on your exchanges, and it's where you place new ones, from a single order to a staggered ladder spread across a price range.",
    },
    {
      say: "A limit order waits until the market reaches your price. Buys rest below the current price, and sells rest above it.",
      act: async h => { await h.spot('#limit-orders-page .overview-header'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "The table is split into buys and sells, with a count on each tab. The New order button follows the tab you're on.",
      act: async h => {
        await h.spot('.limit-header-actions');
        await h.click('#limit-side-tabs [data-side="sell"]');
        await h.wait(1200);
        await h.click('#limit-side-tabs [data-side="buy"]');
        await h.wait(600);
        await h.spot(null);
      },
    },
    {
      say: "Each row shows the account, pair, limit price, volume, and how much has filled, with a partial tag if some has traded. Estimated total is the limit price times the volume.",
      act: async h => {
        await h.spot('#limit-thead');
        await h.wait(2500);
        await h.spot(null);
        await h.hover('#limit-tbody .limit-partial-tag');
        await h.wait(1200);
      },
    },
    {
      chapter: 'Sorting and filtering',
      say: "Click a column heading to sort by it, and click again to flip the order. By default, the newest orders sit at the top.",
      act: async h => {
        await h.click('#limit-thead th[data-sort="price"]');
        await h.wait(1000);
        await h.click('#limit-thead th[data-sort="price"]');
        await h.wait(1000);
        await h.click('#limit-thead th[data-sort="opened"]');
        await h.wait(500);
      },
    },
    {
      say: "The filter box narrows the table by pair or order ID, and the counts on the tabs follow it.",
      act: async h => {
        await h.type('#limit-filter-input', 'ETH');
        await h.wait(500);
        await h.spot('.limit-toolbar');
        await h.wait(1400);
        await h.spot('#limit-side-tabs');
        await h.wait(1300);
        await h.spot(null);
      },
    },
    {
      say: "With All Exchanges selected, a second menu shows a single account. Clear them both, and everything comes back.",
      act: async h => {
        await h.click('#limit-filter-clear');
        await h.select('#limit-filter-exchange', 'Main');
        await h.wait(1500);
        await h.select('#limit-filter-exchange', '');
        await h.wait(300);
      },
    },
    {
      chapter: 'Details and cancelling',
      say: "Click a row for the full details: what has filled, what's left, when it was opened, and its complete ID. This view is read only, so just looking can never cancel anything.",
      act: async h => {
        await h.click(`${PARTIAL_ROW} td.limit-pair-cell`);
        await h.wait(500);
        await h.spot('#order-details-overlay .edit-rule-modal');
        await h.wait(3500);
        await h.spot(null);
        await h.click('#order-details-dismiss');
      },
    },
    {
      say: "To cancel an order, use the Cancel button on its row. Cyrus asks you to confirm, because it can't be undone. On a partly filled order, only the remainder is cancelled. We'll keep this one.",
      act: async h => {
        await h.click(`${PARTIAL_ROW} .btn-cancel-order`);
        await h.wait(500);
        await h.spot('#cancel-order-overlay .edit-rule-modal');
        await h.wait(4000);
        await h.spot(null);
        await h.click('#cancel-order-dismiss');
      },
    },
    {
      chapter: 'Setting up a ladder',
      say: "Now let's build a ladder. On the Sell tab, the button becomes New sell limit order. Click it, and a three-step wizard opens.",
      act: async h => {
        await h.click('#limit-side-tabs [data-side="sell"]');
        await h.wait(900);
        await h.click('#limit-new-order-btn');
        await h.settle(900);
      },
    },
    {
      say: "Step one is what and where. The side comes from the tab you were on, and Exchange picks which account places the orders. Here, that's Main, on Kraken.",
      act: async h => { await h.spot('#limit-step-setup .form-row'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "When you're selling, the coin list only offers coins you hold. When you're buying, it also lists coins the exchange trades that you don't hold yet. We'll sell some SOL.",
      act: async h => {
        await h.spot('#limit-base-select');
        await h.wait(1500);
        await h.select('#limit-base-select', 'SOL');
        await h.spot(null);
        await h.settle(700);
      },
    },
    {
      say: "Order style is Single or Staggered. Single places one order at a price and amount you choose. Staggered spreads one total across several orders at different prices.",
      act: async h => {
        await h.spot('#limit-mode-toggle');
        await h.hover('#limit-mode-toggle [data-mode="single"]');
        await h.wait(1500);
        await h.hover('#limit-mode-toggle [data-mode="ladder"]');
        await h.wait(800);
        await h.spot(null);
      },
    },
    {
      say: "Then pick one or more trading pairs, each showing your balance. With more than one, the steps take turns: the first on USD, the next on USDC, then back to USD.",
      act: async h => {
        await h.spot('#limit-quote-picker');
        await h.wait(1500);
        await h.click('#limit-quote-picker [data-quote="USDC"]');
        await h.wait(800);
        await h.spot('#limit-quote-hint');
        await h.wait(2000);
        await h.spot(null);
      },
    },
    {
      chapter: 'Price and size',
      say: "Click Next. Step two shows the market price for each pair. Number of steps is how many orders to make, up to fifty per selected pair, and the hint says how long they'll take to place.",
      act: async h => {
        await h.click('#limit-wizard-next');
        await h.wait(700);
        await h.spot('#limit-market-price');
        await h.wait(1800);
        await h.spot('#limit-params-ladder .form-group:has(#limit-steps)');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "The price band sets how far from the market the ladder sits, here two to twelve percent above it. Cyrus splits the band into equal slices, one per step, and picks a random price inside each, so the ladder stays in order and no step can cross the market.",
      act: async h => {
        await h.type('#limit-band-start', '2');
        await h.type('#limit-band-end', '12');
        await h.spot('#limit-params-ladder .form-group:has(#limit-band-mode)');
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "Exact prices lets you type the range yourself, starting from the band you set. For a sell, the second price must be higher than the first. We'll stay with percentages.",
      act: async h => {
        await h.click('#limit-band-mode [data-band="price"]');
        await h.wait(600);
        await h.spot('#limit-band-price-row');
        await h.wait(2500);
        await h.spot(null);
        await h.click('#limit-band-mode [data-band="percent"]');
      },
    },
    {
      say: "Total to use is the share of your free balance the ladder can commit. Coins already tied up in other orders don't count. The line underneath shows what that works out to.",
      act: async h => {
        await h.click('#limit-pct-presets [data-pct="50"]');
        await h.wait(1200);
        await h.click('#limit-pct-presets [data-pct="25"]');
        await h.wait(400);
        await h.spot('#limit-total-hint');
        await h.wait(2000);
        await h.spot(null);
      },
    },
    {
      say: "Cyrus also checks that every step clears the exchange's minimum order size and value. If your balance can't stretch that far, it tells you how many steps it can cover.",
      act: async h => { await h.spot('#limit-steps-hint'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "Post-only is on by default. If the market has already reached your price, the order is rejected rather than filled, so you pay maker fees, not taker fees.",
      act: async h => { await h.spot('#limit-postonly-row'); await h.wait(3000); await h.spot(null); },
    },
    {
      chapter: 'Reviewing the ladder',
      say: "Click Next, and step three lists every order before anything is sent: the pair, price, amount, estimated total, and distance from the market. Amounts are rounded down, so the ladder never adds up to more than you set aside.",
      act: async h => {
        await h.click('#limit-wizard-next');
        await h.wait(700);
        await h.spot('.limit-legs-wrap');
        await h.wait(4000);
        await h.spot(null);
      },
    },
    {
      say: "Every price and amount can be edited, and the cross removes a step. A step that can't be placed, say it's under the exchange's minimum, is outlined in red, with the reason listed below. Nothing is sent until every step is valid.",
      act: async h => {
        await h.hover('#limit-legs-tbody input[data-field="price"]');
        await h.wait(1500);
        await h.hover('#limit-legs-tbody input[data-field="amount"]');
        await h.wait(1200);
        await h.hover('#limit-legs-tbody .limit-leg-remove');
        await h.wait(1200);
      },
    },
    {
      say: "Regenerate prices draws a new random price inside each slice, and keeps any amounts you changed. Reset rebuilds the ladder from step two.",
      act: async h => {
        await h.click('#limit-regen-prices');
        await h.wait(1500);
        await h.hover('#limit-reset-legs');
        await h.wait(1000);
      },
    },
    {
      say: "Open Advanced to shape how the total is spread, one bar per step. Presets cover the common shapes. Far out puts more on the steps furthest from the market: better prices, but less likely to fill.",
      act: async h => {
        await h.click('#limit-dist summary');
        await h.wait(800);
        await h.click('#limit-dist-shapes [data-preset="far"]');
        await h.wait(500);
        await h.spot('#limit-dist .limit-dist-frame');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Drag the bright line to move the price level that half the volume sits within, or use the slider to bunch it together or push it to both ends. Reshaping only moves volume between steps. It never adds any.",
      act: async h => {
        await h.hover('#limit-dist-handle');
        await h.wait(1800);
        await h.hover('#limit-dist-shape');
        await h.wait(1200);
        await h.spot('#limit-dist-readback');
        await h.wait(1800);
        await h.spot(null);
      },
    },
    {
      say: "Orders go out one at a time, paced to suit the exchange. You can leave this page meanwhile, but closing Cyrus stops the rest from being sent. When you're happy, click Place.",
      act: async h => {
        await h.spot('#limit-estimate');
        await h.wait(1600);
        await h.spot('#limit-legs-summary');
        await h.wait(1600);
        await h.spot('#limit-step-review .limit-batch-warning');
        await h.wait(2400);
        await h.spot(null);
        await h.click('#limit-submit');
        await h.wait(500);
      },
    },
    {
      chapter: 'Placing in the background',
      say: "A progress panel appears above the table. Each order moves from queued, to placing, to placed, with its order ID alongside.",
      act: async h => { await h.spot('#limit-progress-section'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "While it runs, new batches have to wait, and Stop halts the rest. Anything already placed stays on the exchange, and you'd cancel it from the table.",
      act: async h => { await h.spot('#limit-progress-section .section-header'); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "You don't have to wait here. On any other page, the pill in the top bar keeps track of the batch. Click it to come straight back.",
      act: async h => {
        await h.nav('home');
        await h.wait(600);
        await h.spot('#order-job-pill');
        await h.wait(2000);
        await h.spot(null);
        await h.click('#order-job-pill');
        await h.settle(900);
      },
    },
    {
      say: "Here, the demo rejects two orders on purpose. A rejected order shows the exchange's reason, and the rest carry on, unless the problem would sink them all, like invalid keys, a rate limit, or running out of funds.",
      act: async h => {
        await h.box('#limit-progress-footer');
        await h.spot('#limit-progress-section .limit-progress-table');
        await h.wait(4000);
        await h.spot(null);
      },
    },
    {
      say: "Dismiss clears the panel and the pill. Back on the Sell tab, the new orders are at the top of the table.",
      act: async h => {
        await h.spot('#limit-progress-footer');
        await h.wait(1800);
        await h.spot(null);
        await h.click('#limit-progress-dismiss');
        await h.wait(500);
        await h.click('#limit-side-tabs [data-side="sell"]');
        await h.wait(600);
        await h.hover(`${ROW(1)} td.limit-pair-cell`);
      },
    },
    {
      chapter: 'Seeing your orders',
      say: "Further down, a chart shows what each coin is being sold into. Each bar is one pair on one account, sized by what it would pay out, in that pair's currency, if every order on it fills.",
      act: async h => {
        await h.scrollTo(SOL_FLOW);
        await h.spot(SOL_FLOW);
        await h.wait(4000);
        await h.spot(null);
      },
    },
    {
      say: "Below that, a histogram shows where one pair's orders sit by price, with the market price marked. Here's SOL to USD, with the new ladder stepping up above the market.",
      act: async h => {
        await h.scrollTo('#limit-shape-section');
        await h.select('#limit-shape-pair', 'SOL/USD');
        await h.wait(600);
        await h.spot('#limit-shape-section');
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "The line underneath says how far the price has to move before half of it fills. Hover a bar to see the orders inside it.",
      act: async h => {
        await h.spot('#limit-shape-readback');
        await h.wait(2200);
        await h.spot(null);
        await h.hover('#limit-shape-bars .limit-dist-row');
        await h.wait(1500);
      },
    },
    {
      chapter: 'Bulk cancel and export',
      say: "Now let's cancel the ladder. Back at the top, tick each new order, and a bar appears with a count. The header box ticks every row the filter is showing.",
      act: async h => {
        await h.scroll(-8000, { ms: 1400 });
        for (let n = 1; n <= 6; n++) await h.click(`${ROW(n)} .limit-row-check`, { pause: 150 });
        await h.spot('#limit-bulk-bar');
        await h.wait(1500);
        await h.spot(null);
      },
    },
    {
      say: "A selection only covers rows you can see, so a bulk cancel never reaches anything off screen. Click Cancel, and every order is listed in full before you confirm.",
      act: async h => {
        await h.hover('#limit-select-all');
        await h.wait(1500);
        await h.click('#limit-bulk-cancel');
        await h.wait(500);
        await h.spot('#bulk-cancel-overlay .edit-rule-modal');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Confirm, and they're cancelled one at a time, about a second apart, each row reporting its result. Any that fail stay ticked so you can try again. These all went through, so the dialog closes on its own.",
      act: async h => {
        await h.click('#bulk-cancel-confirm');
        await h.locator('#bulk-cancel-overlay').waitFor({ state: 'hidden', timeout: 30000 });
        await h.wait(400);
      },
    },
    {
      say: "Export CSV saves every buy and sell order matching your filters as a spreadsheet. Sells priced in dollars also get a cost basis and an estimated gain, using the lot matching method from the Taxes page.",
      act: async h => { await h.hover('#limit-export-btn'); await h.spot('#limit-export-btn'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "The table refreshes every four minutes, and after anything you place or cancel. That's Limit Orders: watch what's resting, build ladders with a full review first, and cancel in bulk when plans change.",
      act: async h => { await h.spot('#limit-page-subtitle'); await h.wait(2500); await h.spot(null); },
    },
  ],
};
