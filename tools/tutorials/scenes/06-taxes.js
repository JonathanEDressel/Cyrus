// Taxes — trade-history sync, realized gains by FIFO or HIFO, short and long
// term, cost basis across exchanges, missing costs, and exports.
//
// Demo-mode notes: saving a cost (Fix / Add a purchase) and both exports throw
// "not available in demo mode", so the dialogs are opened, filled in and
// cancelled, and the export buttons are only hovered.

const CONN = text => `.taxes-conn:has-text("${text}")`;
const FIX_ROW = '#taxes-tbody tr:has(.taxes-fix-btn)';

module.exports = {
  id: 'taxes',
  order: 6,
  title: 'Taxes',
  subtitle: 'Realized gains and cost basis, worked out from your own trade history.',
  summary: 'Syncing trade history, FIFO and HIFO, short and long term, how cost basis follows your coins between exchanges, filling in missing costs, and exporting for Form 8949 or Koinly.',
  setup: async h => { await h.nav('taxes'); await h.settle(1200); },
  steps: [
    {
      chapter: 'Introduction',
      say: "This is the Taxes page. It works out your realized gains and cost basis from the trades and transfers on your connected exchanges.",
      act: async h => { await h.spot('.taxes-page .overview-header'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "Cost basis is what you paid for a coin, including fees. When you sell, the difference between what you received and what you paid is your realized gain or loss. Cyrus replays your whole history to work that out, sale by sale.",
    },
    {
      chapter: 'Syncing trade history',
      say: "At the top is your trade history, one card for each exchange account, showing how many trades Cyrus has stored, when it last synced, and a status badge.",
      act: async h => { await h.spot('#taxes-connections'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "Up to date means the full history is in. Partly synced means Cyrus is still working back through it, so the figures may be incomplete. Needs permission means the API key can't read trade history, and the card says what to change.",
      act: async h => { await h.spot(`${CONN('Kraken')} .taxes-badge`); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "Some exchanges have limits. Binance and Gemini only report trades one market at a time, so Cyrus checks the markets for coins you hold, have moved, or have traded. Robinhood has no record of individual fills, so each filled order counts as one trade.",
      act: async h => {
        await h.spot(CONN('Binance'));
        await h.wait(3000);
        await h.spot(CONN('Robinhood'));
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Your first visit syncs anything Cyrus hasn't seen. After that, Sync history fetches new trades from every exchange, then your deposits and withdrawals, because a move between your own exchanges carries cost basis with it.",
      act: async h => {
        await h.click('#taxes-sync-btn');
        await h.settle(1200);
        await h.spot('#taxes-success');
        await h.wait(2000);
        await h.spot(null);
      },
    },
    {
      chapter: 'Realized gains',
      say: "Realized gains covers one tax year. First, choose how Cyrus decides which coins you sold. FIFO, first in, first out, treats your oldest coins as sold first.",
      act: async h => {
        await h.scrollTo('#taxes-method-tabs', { offset: 120 });
        await h.spot('#taxes-method-tabs');
        await h.hover('#taxes-method-tabs [data-method="fifo"]');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "HIFO, highest in, first out, treats your most expensive coins as sold first, which usually means a smaller gain. Watch the figures change.",
      act: async h => {
        await h.click('#taxes-method-tabs [data-method="hifo"]');
        await h.settle(700);
        await h.spot('#taxes-summary');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Cyrus remembers your choice for next time. Let's switch back to FIFO.",
      act: async h => { await h.click('#taxes-method-tabs [data-method="fifo"]'); await h.settle(700); },
    },
    {
      say: "The year menu lists every year you've sold something in, plus the current one. Here's last year, and back to this one. Dates are in universal time, matching the export.",
      act: async h => {
        await h.select('#taxes-year', { index: 1 });
        await h.settle(900);
        await h.wait(1200);
        await h.select('#taxes-year', { index: 0 });
        await h.settle(600);
      },
    },
    {
      say: "The tiles add up the year. Net gain or loss is the total, split into short term, for coins held one year or less, and long term, for coins held more than a year. The two are often taxed differently.",
      act: async h => {
        await h.spot('.taxes-tile');
        await h.wait(2000);
        await h.spot('.taxes-tile >> nth=1');
        await h.wait(1600);
        await h.spot('.taxes-tile >> nth=2');
        await h.wait(1600);
        await h.spot(null);
      },
    },
    {
      say: "Proceeds is what your sales brought in, valued in US dollars at the time of each trade, and cost basis is what those coins cost. Dollars and dollar stablecoins count as cash, so they never make a gain or a loss.",
      act: async h => {
        await h.spot('.taxes-tile >> nth=3');
        await h.wait(2000);
        await h.spot('.taxes-tile >> nth=4');
        await h.wait(2000);
        await h.spot(null);
      },
    },
    {
      chapter: 'Each sale and its cost basis',
      say: "The table lists every sale: the coin and amount, when it was bought and sold, the proceeds, cost, and gain or loss, whether it was short or long term, and the exchange account.",
      act: async h => {
        await h.scrollTo('#taxes-table', { offset: 110 });
        await h.spot('#taxes-table thead');
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "One sale can span several rows when it used coins bought at different times, since each purchase has its own cost and date. Swapping one coin for another counts as selling the first. And a fee paid in a third coin, like BNB on Binance, counts as a small sale of that coin.",
      act: async h => { await h.spot('#taxes-tbody tr'); await h.wait(4000); await h.spot(null); },
    },
    {
      say: "Cyrus tracks your coins separately for each exchange account, because a coin bought on Kraken can't be sold on Binance until you move it there. Sending coins out of an exchange isn't counted as a sale.",
      act: async h => { await h.spot('#taxes-tbody tr td:nth-child(9)'); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "When you move coins between two of your connected exchanges, and the transfer is matched, they keep their original cost and purchase date, and the network fee is added to their cost. That's why confirming matches on the Transfers page matters.",
    },
    {
      chapter: 'Missing cost basis',
      say: "Sometimes Cyrus can't know what you paid. If coins arrived from outside your connected exchanges, or you sold more than your history covers, the cost is marked missing instead of guessed.",
      act: async h => {
        await h.scrollTo(FIX_ROW, { offset: 260 });
        await h.spot(FIX_ROW);
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "Those sales still count toward proceeds but are left out of the gain, and the net gain tile says how many are missing. Check before filing lists what needs attention, like these two thousand ADA deposited from outside.",
      act: async h => {
        await h.scrollTo('#taxes-summary', { offset: 140 });
        await h.spot('.taxes-tile');
        await h.wait(2000);
        await h.spot('#taxes-warnings');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Needs info narrows the table to just the sales missing a cost or a dollar price. The totals still cover the whole year, so you can watch them change as you fill things in.",
      act: async h => {
        await h.click('#taxes-needs-info');
        await h.settle(800);
        await h.spot('#taxes-table');
        await h.wait(2200);
        await h.spot(null);
        await h.click('#taxes-needs-info');
        await h.settle(600);
      },
    },
    {
      chapter: 'Entering costs by hand',
      say: "To fill a gap, click Fix. For coins deposited from outside, enter what you originally paid in total, including fees, and the date you bought them.",
      act: async h => {
        await h.scrollTo(FIX_ROW, { offset: 260 });
        await h.click(`${FIX_ROW} .taxes-fix-btn`);
        await h.wait(800);
        await h.spot('.taxes-fix-modal');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "The purchase date decides short or long term, so use when you bought the coins, not when they arrived. For several purchases, enter the total cost and the most recent date, the cautious choice. As you type, Cyrus shows the cost per coin.",
      act: async h => {
        await h.type('#fix-cost', '1200');
        await h.wait(500);
        await h.hover('#fix-date');
        await h.wait(1200);
        await h.spot('#taxes-fix-preview');
        await h.wait(1800);
        await h.spot(null);
      },
    },
    {
      say: "Other gaps get their own forms. A sale with no purchase history asks for the purchase it came from, and a trade priced in another coin asks what that coin was worth in dollars. We'll cancel this one.",
      act: async h => { await h.wait(2500); await h.click('#taxes-fix-cancel'); await h.wait(500); },
    },
    {
      say: "Entered by hand collects everything you've filled in. Each entry feeds every figure above, is marked as entered manually in the Form 8949 export, and can be removed later.",
      act: async h => {
        await h.scrollTo('#taxes-manual-title', { offset: 160 });
        await h.spot('.taxes-page .overview-section:has(#taxes-manual)');
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "Add a purchase records coins Cyrus never saw, like ones bought before an exchange's records begin, or on another platform. Pick the exchange account, the coin, the amount, the total cost and the date. It counts toward sales on that account.",
      act: async h => {
        await h.click('#taxes-add-lot');
        await h.wait(800);
        await h.spot('.taxes-fix-modal');
        await h.wait(4000);
        await h.spot(null);
        await h.click('#taxes-fix-cancel');
        await h.wait(400);
      },
    },
    {
      chapter: 'Exporting',
      say: "When you're ready, export. Form 8949 CSV gives one row per sale for the selected year and method, in the columns of the IRS form, with a note on anything missing or entered by hand.",
      act: async h => {
        await h.scrollTo('#taxes-method-tabs', { offset: 120 });
        await h.spot('#taxes-export-8949');
        await h.hover('#taxes-export-8949');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Koinly CSV exports every trade and transfer in your full history, in Koinly's universal import format, to import as a single wallet. Moves between your own exchanges are left out, since inside one wallet they'd only be noise.",
      act: async h => {
        await h.spot('#taxes-export-koinly');
        await h.hover('#taxes-export-koinly');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      chapter: 'Wrapping up',
      say: "As the note at the bottom says, this isn't tax advice. Cyrus's figures are a starting point, worked out from the history it could fetch. Review them, and your export, with your tax software or an accountant before you file.",
      act: async h => {
        await h.scrollTo('.taxes-page .transfers-footnote', { offset: 380 });
        await h.spot('.taxes-page .transfers-footnote');
        await h.wait(4000);
        await h.spot(null);
      },
    },
    {
      say: "That's the Taxes page. Keep your history synced, fill in what's missing, and your numbers will be ready whenever you need them.",
      act: async h => { await h.scroll(-5000, { ms: 1400 }); },
    },
  ],
};
