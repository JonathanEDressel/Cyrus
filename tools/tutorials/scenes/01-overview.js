// Overview — the home page. Also the reference scene for the others:
// each step is one or two spoken sentences plus what happens on screen while
// they're spoken. `chapter` marks a jump point in the landing-page player.

const W = type => `.dash-widget[data-widget="${type}"]`;

module.exports = {
  id: 'overview',
  order: 1,
  title: 'The Overview',
  subtitle: 'Your whole crypto picture on one page, and how to make it yours.',
  summary: 'Headline numbers, the portfolio ring, live charts, every widget explained, and how to customise the layout.',
  steps: [
    {
      chapter: 'Introduction',
      say: "Welcome to Cyrus. This is the Overview, the page you land on every time you open the app. It pulls together every exchange you've connected, so you can see your whole crypto picture in one place.",
    },
    {
      say: "Everything you're seeing here is demo data, but it behaves exactly like a real account. In this one, four exchanges are connected: Kraken, Coinbase, Binance and Robinhood.",
      act: async h => { await h.spot('.page-header, .overview-header, #app-content h1'); await h.wait(2500); await h.spot(null); },
    },
    {
      chapter: 'The top bar',
      say: "Let's start at the very top. The search box takes you to any page. Press the slash key, type a few letters, like 'tax', and press Enter.",
      act: async h => { await h.spot('#command-search'); await h.wait(1200); await h.spot(null); },
    },
    {
      say: "Next to it is the exchange selector. On All Exchanges, every number in the app is combined across your accounts. Pick a single account, and every page narrows to just that one.",
      act: async h => {
        await h.spot('#exchange-selector');
        await h.wait(1200);
        await h.select('#exchange-selector', { label: 'Main' });
        await h.spot(null);
        await h.settle(1800);
      },
    },
    {
      say: "Now we're only looking at the Kraken account called Main. The portfolio, the orders and the caps have all been recalculated for it. Let's switch back to everything.",
      act: async h => {
        await h.spot('.dash-widget[data-widget="stats"]');
        await h.wait(2600);
        await h.spot(null);
        await h.select('#exchange-selector', 'all');
        await h.settle(1200);
      },
    },
    {
      say: "The worker pill shows that the automation engine is running, and how recently it last checked your rules. It runs quietly in the background, about once a minute.",
      act: async h => { await h.spot('#worker-pill'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "Underneath, a ticker scrolls through your portfolio total and live prices for the coins you hold, with the day's change next to each one.",
      act: async h => { await h.moveXY(400, 46); await h.wait(2500); },
    },
    {
      chapter: 'Headline numbers',
      say: "Back on the page, the headline numbers give you the essentials at a glance: what everything's worth, how much it moved in the last twenty-four hours, how many orders are working, how many automations you have, and whether any coin is over its allocation cap.",
      act: async h => {
        await h.spot(W('stats'));
        for (const route of ['holdings', 'openorders', 'limitorders', 'commands', 'rebalancer']) {
          await h.hover(`${W('stats')} a[data-route="${route}"]`, 650);
          await h.wait(500);
        }
        await h.spot(null);
      },
    },
    {
      say: "Each tile is also a shortcut. Clicking one takes you straight to the page with the full detail.",
      act: async h => { await h.hover(`${W('stats')} a[data-route="holdings"]`); await h.wait(800); },
    },
    {
      chapter: 'Portfolio and live prices',
      say: "The portfolio ring shows how your money is split. Each slice is a coin, sized by its dollar value, and the smaller positions are grouped together as Other. The total sits in the middle.",
      act: async h => { await h.spot(W('portfolio')); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "Beside it is a live price chart. Choose a pair from the list, and pick a time range, from the last hour up to the last year.",
      act: async h => {
        await h.spot(W('live-data'));
        await h.wait(800);
        await h.select('#live-data-selector', 'ETH/USD');
        await h.settle(900);
        await h.click(`${W('live-data')} .time-range-btn:has-text("1W")`);
        await h.wait(1200);
        await h.click(`${W('live-data')} .time-range-btn:has-text("1M")`);
        await h.wait(800);
        await h.spot(null);
      },
    },
    {
      say: "Add Crypto puts another coin on your watch list, so you can follow a price even if you don't hold it yet.",
      act: async h => { await h.hover('#add-crypto-btn'); await h.wait(1500); },
    },
    {
      chapter: 'Holdings, orders, caps and activity',
      say: "Scrolling down, Biggest Holdings lists your largest positions with a small price trend, the current price, the day's move, and what each position is worth.",
      act: async h => {
        await h.scrollTo(W('holdings'));
        await h.spot(W('holdings'));
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Resting Limit Orders splits your orders into buys and sells, with the total value on each side, then lists the most recent ones: the pair, the account, the price, the amount and when it was placed.",
      act: async h => { await h.spot(W('limits')); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "Allocation Caps shows each coin against the share of your account you've allowed it. The bar fills toward the cap. When a coin goes over, the bar turns amber, and Cyrus tells you how much it would trim to bring it back in line.",
      act: async h => {
        await h.scrollTo(W('caps'));
        await h.spot(W('caps'));
        await h.wait(4000);
        await h.spot(null);
      },
    },
    {
      say: "Recent Activity is the automation log in miniature. Every run is recorded, including the ones that didn't trade, with a plain-English reason, like a coin being under its cap or a rule waiting out its cooldown.",
      act: async h => { await h.spot(W('activity')); await h.wait(4000); await h.spot(null); },
    },
    {
      chapter: 'The flow chart',
      say: "At the bottom, the Flow chart draws your automations as a map. Each circle is a coin, and each line is a rule that converts one coin into another. Dashed outlines are rules that are paused.",
      act: async h => {
        await h.scrollTo(W('flow'));
        await h.spot(W('flow'));
        await h.wait(4000);
        await h.spot(null);
      },
    },
    {
      say: "Switch to Open Orders, and the same chart shows where your resting orders would take your money if they filled.",
      act: async h => {
        await h.click(`${W('flow')} button[data-tab="orders"]`);
        await h.wait(2500);
        await h.click(`${W('flow')} button[data-tab="automations"]`);
        await h.wait(600);
      },
    },
    {
      chapter: 'Customising the layout',
      say: "Every widget can be rearranged. Scroll back up and click Customize.",
      act: async h => {
        await h.scroll(-5000, { ms: 1400 });
        await h.click('#dash-edit-btn');
        await h.wait(800);
      },
    },
    {
      say: "Each widget now has a toolbar. Drag the grip to move a widget, or use the arrows. The minus and plus buttons make it narrower or wider. The page is a twelve-column grid, and the counter shows how many columns a widget is using.",
      act: async h => {
        await h.spot(`${W('portfolio')} .dash-edit-bar`);
        await h.hover(`${W('portfolio')} button[aria-label="Drag to move"]`);
        await h.wait(700);
        await h.click(`${W('portfolio')} button[aria-label="Narrower"]`);
        await h.wait(900);
        await h.click(`${W('portfolio')} button[aria-label="Wider"]`);
        await h.wait(700);
        await h.spot(null);
      },
    },
    {
      say: "Dragging the bottom-right corner resizes a widget. Its height can follow its content, or stay fixed with the content scrolling inside. Double-click the corner, or use the up-and-down arrow button, to make it fit its content again.",
      act: async h => {
        await h.hover(`${W('live-data')} .dash-resize`);
        await h.wait(1600);
        await h.hover(`${W('live-data')} button[aria-label="Fit height to content"]`);
        await h.wait(800);
      },
    },
    {
      say: "Add Widget opens the full list. Besides the ones you've seen, there's Top Movers, an Accounts summary, Recent Transfers, Quick Actions, and a Notes pad for your own reminders.",
      act: async h => {
        await h.click('#dash-add-btn');
        await h.wait(1500);
        await h.spot('#dash-picker-list');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Let's add Top Movers. It lists the holdings that rose or fell the most over the last day.",
      act: async h => {
        await h.click('#dash-picker-list [data-add-widget="movers"]');
        await h.settle(1200);
        await h.scrollTo(W('movers'));
        await h.spot(W('movers'));
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Your layout saves to your account as you go. If you ever want the original back, Reset restores it. When you're finished, click Done.",
      act: async h => {
        await h.scroll(-6000, { ms: 1400 });
        await h.hover('#dash-reset-btn');
        await h.wait(900);
        await h.click('#dash-done-btn');
        await h.wait(800);
      },
    },
    {
      chapter: 'Wrapping up',
      say: "The refresh button reloads everything from your exchanges straight away, though the Overview also refreshes on its own. That's the Overview. In the next videos, we'll go through each page in detail.",
      act: async h => { await h.click('#ov-refresh'); await h.settle(1500); },
    },
  ],
};
