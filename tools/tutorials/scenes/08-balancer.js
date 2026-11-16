// Balancer — per-account allocation caps that trim a coin back down when it
// grows past its share. Facts here are checked against the allocation path in
// src/backend/automation/worker.py (_poll_allocations), the /allocations
// endpoints in controllers/AutomationController.py and AutomationModel.
//
// Demo mode stubs the holdings and caps, and saving is a no-op, so edits made
// here are shown and then thrown away with Discard changes.

const ROW = a => `#balancer-tbody tr:has([data-asset="${a}"])`;
const COL = a => `#balancer-chart .ac-col[data-asset="${a}"]`;

/** Drag a cap handle on the chart to a new percentage, moving the visible
 *  cursor with the real mouse so the drag reads on video. */
async function dragCap(h, asset, pct) {
  const handle = `#balancer-chart [data-handle="${asset}"]`;
  const b = await h.box(handle);
  const x = b.x + b.width / 2;
  const y0 = b.y + b.height / 2;
  const y1 = await h.eval(p => {
    const labels = [...document.querySelectorAll('#balancer-chart .ac-axis-label')];
    const mid = t => { const r = labels.find(l => l.textContent.trim() === t).getBoundingClientRect(); return r.top + r.height / 2; };
    const top = mid('100%'), bottom = mid('0%');
    return bottom - (bottom - top) * p / 100;
  }, pct);
  await h.moveXY(x, y0, 600);
  await h.page.mouse.move(x, y0);
  await h.page.mouse.down();
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    const y = y0 + (y1 - y0) * (i / steps);
    await h.page.mouse.move(x, y);
    await h.eval(([a, c]) => window.__tut.moveTo(a, c, 40), [x, y]);
    await h.wait(45);
  }
  await h.page.mouse.up();
  await h.wait(300);
}

module.exports = {
  id: 'balancer',
  order: 8,
  title: 'The Balancer',
  subtitle: 'Keep any one coin from taking over an account.',
  summary: 'Allocation caps per coin and per account, how a trim is worked out, the chart and table, the safety settings, and saving.',
  setup: async h => { await h.nav('rebalancer'); await h.settle(1500); },
  steps: [
    {
      chapter: 'Introduction',
      say: "This is the Balancer. It caps how much of an exchange account any one coin is allowed to become. When a coin grows past its cap, Cyrus sells the excess and brings it back down.",
      act: async h => { await h.spot('.overview-header'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "Why bother? When one coin rallies, it can quietly grow into most of your account. A cap takes some profit along the way and keeps your risk spread out.",
    },
    {
      chapter: 'One account at a time',
      say: "Caps are set per account, and this menu picks which one. Everything on the page is that account alone. Here it's the Kraken account called Main. The Balancer works with every exchange Cyrus supports.",
      act: async h => { await h.spot('.balancer-toolbar'); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "Switch accounts, and you see that account's own holdings and caps, measured against its own total. Let's go back to Main.",
      act: async h => {
        await h.select('#balancer-connection', { label: 'Trading' });
        await h.settle(1200);
        await h.wait(1500);
        await h.select('#balancer-connection', { label: 'Main' });
        await h.settle(1000);
      },
    },
    {
      chapter: 'Reading the chart',
      say: "Each bar is one holding's share of the account, by its value in dollars. The account total is underneath.",
      act: async h => {
        await h.spot('#balancer-chart');
        await h.wait(2500);
        await h.spot('#balancer-total');
        await h.wait(1200);
        await h.spot(null);
      },
    },
    {
      say: "A capped coin has a handle at its maximum share, labelled with the percent. The dashed line is the down to level, where a trim stops. Below the bar is its share now, and the coin it sells into.",
      act: async h => { await h.spot(COL('ETH')); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "When a coin is at or over its cap, the bar turns amber. Bitcoin here is almost forty two percent of the account, against a cap of thirty.",
      act: async h => { await h.spot(COL('BTC')); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "Fit zooms the scale in, which helps when your caps are small. Zero to a hundred shows the whole range again.",
      act: async h => {
        await h.click('#balancer-scale-toggle button[data-scale="fit"]');
        await h.wait(1500);
        await h.click('#balancer-scale-toggle button[data-scale="100"]');
        await h.wait(600);
      },
    },
    {
      chapter: 'How a trim works',
      say: "Here's exactly what happens. On each check, about once a minute, Cyrus prices the account in dollars and works out each coin's share. If a coin has reached its cap, it sells enough to bring it down to the down to level.",
    },
    {
      say: "For bitcoin, that's from about forty two percent down to twenty five: roughly seventeen thousand dollars, or about a quarter of a bitcoin, sold into USDC with a market order.",
      act: async h => {
        await h.scrollTo(ROW('BTC'), { offset: 200 });
        await h.spot(`[data-preview="BTC"]`);
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "Why stop below the cap? Trimming only to the cap would let the next small rise set off another sale. The gap stops it trading back and forth, so the down to level must be lower than the maximum.",
    },
    {
      chapter: 'Setting caps',
      say: "The Positions table holds the same caps as numbers, alongside your holdings, their value, their share now, and what Cyrus would trim right now.",
      act: async h => { await h.spot('#balancer-table thead'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "Would Trim Now uses the same sums as the engine, so it's an honest preview of the next check. Ether is under its cap, so nothing would be sold.",
      act: async h => { await h.spot(ROW('ETH')); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "You can drag a cap's handle on the chart. Pull ether's cap below its current share, and it's over straight away. If the down to level would no longer sit below the cap, Cyrus moves it down for you.",
      act: async h => {
        await h.scrollTo('#balancer-chart', { offset: 140 });
        await dragCap(h, 'ETH', 16);
        await h.wait(800);
        await h.spot(COL('ETH'));
        await h.wait(1800);
        await h.spot(null);
      },
    },
    {
      say: "The table follows along, with a trim that would now happen. You can also type the numbers into the table instead.",
      act: async h => {
        await h.scrollTo(ROW('ETH'), { offset: 200 });
        await h.spot(ROW('ETH'));
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "To cap a coin that has none, tick its box. Cyrus suggests a cap about five points above where it sits today, a down to level five points lower, and, where it can, a stablecoin to sell into.",
      act: async h => {
        await h.click('input[data-field="enabled"][data-asset="AVAX"]');
        await h.wait(600);
        await h.spot(ROW('AVAX'));
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Convert Into offers dollars, the main stablecoins, bitcoin and ether, but only the ones this exchange can actually trade the coin for.",
      act: async h => {
        await h.select('select[data-field="convertTo"][data-asset="AVAX"]', 'BTC');
        await h.wait(800);
        await h.select('select[data-field="convertTo"][data-asset="AVAX"]', 'USDC');
      },
    },
    {
      say: "Untick a box to pause a cap. Its numbers are kept, but it won't trade until you tick it again. To remove a cap completely, clear its maximum.",
      act: async h => {
        await h.click('input[data-field="enabled"][data-asset="SOL"]');
        await h.wait(600);
        await h.spot(ROW('SOL'));
        await h.wait(2200);
        await h.spot(null);
        await h.click('input[data-field="enabled"][data-asset="SOL"]');
      },
    },
    {
      chapter: 'Safety settings',
      say: "Below are three safety settings, shared by every cap on this account. Cooldown is the shortest time between two trims of the same coin. It starts at one day, fourteen hundred and forty minutes, so a choppy market can't make it trade over and over.",
      act: async h => {
        await h.scrollTo(ROW('SOL'), { offset: 150 });
        await h.spot('#balancer-cooldown');
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "Minimum trade skips a trim worth less than this, twenty five dollars to start with. Raise it to five thousand, and the solana trim, worth about three thousand, is now under the minimum.",
      act: async h => {
        await h.type('#balancer-min-trade', '5000');
        await h.wait(500);
        await h.spot(ROW('SOL'));
        await h.wait(2500);
        await h.spot(null);
        await h.type('#balancer-min-trade', '25');
      },
    },
    {
      say: "With Simulate Only, Cyrus places no orders. It writes what it would have traded into the Automations log instead. It's a sensible way to watch the Balancer for a while before trusting it with real money.",
      act: async h => {
        await h.click('label.balancer-check');
        await h.wait(600);
        await h.spot(`[data-preview="BTC"]`);
        await h.wait(2500);
        await h.spot(null);
        await h.click('label.balancer-check');
      },
    },
    {
      chapter: 'Saving',
      say: "Nothing changes until you click Save Balancer. Saving replaces this account's whole set of caps: caps on the page are created or updated, and any cap you cleared is removed.",
      act: async h => {
        await h.scrollTo('#balancer-dirty', { offset: 120 });
        await h.spot('#balancer-dirty');
        await h.wait(1500);
        await h.spot(null);
        await h.scrollTo('#balancer-save', { offset: 400 });
        await h.hover('#balancer-save');
        await h.wait(1200);
      },
    },
    {
      say: "Cyrus checks every cap first: the down to level must be below the maximum, and the exchange must have a market to sell into. If not, it names the coin and saves nothing.",
    },
    {
      say: "Discard Changes throws your edits away and reloads what's saved. We'll do that now, since this is only a demo.",
      act: async h => { await h.click('#balancer-reset'); await h.settle(1000); },
    },
    {
      chapter: 'Where trims show up',
      say: "Once saved, each cap is an automation like any other. It's checked on the engine's regular cycle, listed on the Automations page, every trim or skip goes in the log, and trims are emailed to you if alerts are on.",
      act: async h => { await h.spot('.balancer-footnote'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "The refresh button reloads your holdings from the exchange.",
      act: async h => {
        await h.scroll(-5000, { ms: 1400 });
        await h.click('#balancer-refresh');
        await h.settle(1000);
      },
    },
    {
      chapter: 'Wrapping up',
      say: "That's the Balancer. For each coin, choose a maximum, a level to come back down to, and what to sell into, and Cyrus keeps each account in shape.",
    },
  ],
};
