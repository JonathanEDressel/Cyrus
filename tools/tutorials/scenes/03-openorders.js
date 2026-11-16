// Open Orders — every resting order on your exchanges, as a flow chart or a table.

const FIRST_EX = '#orders-flow-chart .rf-exchange:first-child';

// The visible cursor is drawn by the overlay; the real mouse stays where the
// last hover left it. This tells the chart the mouse has gone, so its tooltip
// and highlighted lines clear before the next thing is shown.
const unhover = h => h.eval(() => document.getElementById('orders-flow-chart')
  ?.dispatchEvent(new MouseEvent('mouseleave')));

module.exports = {
  id: 'openorders',
  order: 3,
  title: 'Open Orders',
  subtitle: 'Every order waiting on your exchanges, as a flow chart or a table.',
  summary: 'How orders are fetched and refreshed, reading the order flow chart, narrowing to one account, and every column in the orders table.',
  setup: async h => { await h.nav('openorders'); await h.settle(1200); await h.moveXY(640, 420, 300); },
  steps: [
    {
      chapter: 'Introduction',
      say: "This is Open Orders. It shows every order you have resting on your exchanges, waiting to fill. Cyrus reads them straight from each exchange you've connected.",
      act: async h => { await h.spot('.overview-header'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "Under the title is the time the list was last updated. Cyrus checks your exchanges for orders every four minutes in the background, and straight away whenever you switch accounts.",
      act: async h => { await h.spot('#page-subtitle'); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "The heading counts how many orders are open on the accounts you're looking at. On the right, you can switch between two views: a flow chart, which is where the page opens, and a table.",
      act: async h => {
        await h.spot('#orders-count-title');
        await h.wait(1800);
        await h.spot('#orders-tab-strip');
        await h.wait(1800);
        await h.spot(null);
      },
    },
    {
      chapter: 'The flow chart',
      say: "The flow chart shows where your money would move if your orders filled. A sell order moves money out of the coin you're selling and into the one you'd be paid in. A buy order does the opposite.",
      act: async h => {
        await h.move(`${FIRST_EX} .rf-node-source`, 900);
        await h.wait(1200);
        await h.moveXY(560, 700, 1600);
        await h.wait(600);
      },
    },
    {
      say: "On All Exchanges, each account gets its own panel, with its name at the top.",
      act: async h => { await h.spot(`${FIRST_EX} .rf-exchange-title`); await h.wait(2200); await h.spot(null); },
    },
    {
      say: "Each circle is a coin, and each line is one or more orders between two coins. The coins at the top are the ones your orders only spend.",
      act: async h => {
        await h.spot(`${FIRST_EX} .rf-row:first-child`);
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Hover over a coin to see the orders behind it. Its lines light up and the others fade back, and a tooltip lists each order: buy or sell, the pair, the amount and the price.",
      act: async h => {
        await h.hover(`${FIRST_EX} .rf-node-source`);
        await h.wait(3500);
      },
    },
    {
      say: "Further down, the lines arrive at the coins you'd receive. A green outline marks a coin your orders only receive. Hover over one, and the tooltip tells you which coins it would come from.",
      act: async h => {
        await unhover(h);
        await h.moveXY(640, 230, 400);
        await h.scrollTo(`${FIRST_EX} .rf-node-terminal`, { offset: 330, ms: 1300 });
        await h.hover(`${FIRST_EX} .rf-node-terminal`);
        await h.wait(2500);
      },
    },
    {
      say: "The figure under a coin is how much of it you'd receive if every order flowing into it filled in full. For dollars and stablecoins, it's shown as a dollar amount.",
      act: async h => {
        await unhover(h);
        await h.moveXY(640, 230, 400);
        await h.spot(`${FIRST_EX} .rf-node-mid .rf-node-amount`);
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      chapter: 'One account at a time',
      say: "With four accounts connected, that's a lot of orders. To focus on one, use the exchange selector at the top. Let's pick the Robinhood account called Crypto.",
      act: async h => {
        await h.scroll(-6000, { ms: 1200 });
        await h.spot('#exchange-selector');
        await h.wait(800);
        await h.select('#exchange-selector', { label: 'Crypto' });
        await h.spot(null);
        await h.settle(1500);
      },
    },
    {
      say: "Now the chart shows only that account's orders. The subtitle names the account, and the count drops to match.",
      act: async h => {
        await h.spot('#page-subtitle');
        await h.wait(1500);
        await h.spot('#orders-count-title');
        await h.wait(1500);
        await h.spot(null);
      },
    },
    {
      say: "Here it's easier to follow the story. The coins being sold feed into dollars, and dollars feed the coins being bought.",
      act: async h => {
        const usd = '#orders-flow-chart .rf-node[data-key="A:USD"]';
        await h.scrollTo(usd, { offset: 200, ms: 1200 });
        await h.hover(usd);
        await h.wait(3500);
        await unhover(h);
        await h.moveXY(640, 200, 400);
      },
    },
    {
      chapter: 'The table',
      say: "Now let's switch to the table. It lists the same orders, one row each.",
      act: async h => {
        await h.scroll(-6000, { ms: 900 });
        await h.click('#orders-tab-strip button[data-tab="table"]');
        await h.settle(700);
      },
    },
    {
      say: "Order ID is the exchange's own reference for the order, and Pair is the market it's on. Side is buy or sell, in green or red, and Type is the kind of order, such as a limit order.",
      act: async h => {
        await h.spot('#orders-table thead');
        await h.hover('#orders-thead th:nth-child(1)');
        await h.wait(900);
        await h.hover('#orders-thead th:nth-child(2)');
        await h.wait(800);
        await h.hover('#orders-thead th:nth-child(3)');
        await h.wait(800);
        await h.hover('#orders-thead th:nth-child(4)');
        await h.wait(600);
        await h.spot(null);
      },
    },
    {
      say: "Price is the price the order is waiting for. Volume is the full size of the order, and Filled is how much of it has already traded.",
      act: async h => {
        await h.hover('#orders-thead th:nth-child(5)');
        await h.wait(1000);
        await h.hover('#orders-thead th:nth-child(6)');
        await h.wait(1000);
        await h.hover('#orders-thead th:nth-child(7)');
        await h.wait(900);
      },
    },
    {
      say: "Like this Dogecoin buy order. Part of it has already filled, and the rest is still waiting on the exchange.",
      act: async h => {
        await h.spot('#orders-tbody tr:has-text("d159d159")');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Status is what the exchange reports for the order, and Opened is when it was placed.",
      act: async h => {
        await h.hover('#orders-thead th:nth-child(8)');
        await h.wait(1200);
        await h.hover('#orders-thead th:nth-child(9)');
        await h.wait(1000);
      },
    },
    {
      say: "Switch back to All Exchanges, and the table gains an Exchange column at the front, so you can always tell which account an order belongs to.",
      act: async h => {
        await h.select('#exchange-selector', 'all');
        await h.settle(1500);
        await h.spot('#orders-thead th:first-child');
        await h.wait(2200);
        await h.spot(null);
      },
    },
    {
      chapter: 'Acting on your orders',
      say: "Open Orders is for keeping an eye on things, so there's nothing to change here. To place new limit orders or cancel existing ones, use the Limit Orders page, just below in the sidebar.",
      act: async h => { await h.hover('.nav-link[data-route="limitorders"]'); await h.wait(2500); },
    },
    {
      say: "Your automations can also watch these orders. A rule can wait for one of them to fill, and then run an action for you, like a conversion or a withdrawal.",
      act: async h => { await h.hover('.nav-link[data-route="commands"]'); await h.wait(2500); },
    },
    {
      chapter: 'Wrapping up',
      say: "That's Open Orders: every resting order in one place, as a map of where your money is headed or as a detailed table. Next, we'll look at limit orders.",
      act: async h => {
        await h.click('#orders-tab-strip button[data-tab="flow"]');
        await h.settle(900);
        await h.moveXY(640, 420);
      },
    },
  ],
};
