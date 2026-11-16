// Holdings — every coin you own, what it's worth, and the market behind it.

const CARD = n => `#holdings-summary .holdings-card:nth-child(${n})`;
const BLOCK = n => `#holdings-detail .holdings-detail-block:nth-child(${n})`;
const ROW = asset => `#holdings-tbody tr[data-asset="${asset}"]`;
const TH = key => `#holdings-thead th[data-sort="${key}"]`;
const TABLE = '.holdings-page .data-table-wrapper';

module.exports = {
  id: 'holdings',
  order: 2,
  title: 'Holdings',
  subtitle: 'What you own, what it is worth, and the market behind every coin.',
  summary: 'The summary cards, every column in the assets table, sorting, and the full breakdown behind each coin.',
  setup: async h => { await h.nav('holdings'); await h.settle(1200); await h.moveXY(640, 420, 300); },
  steps: [
    {
      chapter: 'Introduction',
      say: "This is the Holdings page. The Overview gives you the headlines. Here, you go coin by coin: what you hold, what it's worth, and what the wider market looks like behind each one.",
      act: async h => { await h.spot('.holdings-page .overview-header'); await h.wait(2500); await h.spot(null); },
    },
    {
      chapter: 'Choosing accounts',
      say: "Holdings has its own account picker, up here on the right. It starts on whatever you chose in the exchange selector, and changing it here only changes this page.",
      act: async h => { await h.spot('.holdings-toolbar'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "Let's pick the Kraken account called Main. The cards and the table now cover just that one account.",
      act: async h => {
        await h.select('#holdings-connection', { label: 'Main' });
        await h.settle(900);
        await h.spot('#holdings-summary');
        await h.wait(2200);
        await h.spot(null);
      },
    },
    {
      say: "On All exchanges, a coin you hold in several places shows up once, with the amounts added together. Let's switch back to everything.",
      act: async h => {
        await h.select('#holdings-connection', 'all');
        await h.settle(900);
      },
    },
    {
      say: "The page doesn't reload on its own. If you've had it open for a while, the refresh button fetches your balances and prices again.",
      act: async h => { await h.click('#holdings-refresh'); await h.settle(900); },
    },
    {
      chapter: 'The summary cards',
      say: "Across the top are five summary cards. Total value is everything on the selected accounts, in dollars. Underneath, you can see how many coins that covers, and how much of it is cash.",
      act: async h => { await h.spot(CARD(1)); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "The twenty-four hour change adds up how much each position gained or lost in dollars over the last day. Below it, that move is shown as a percentage of what the portfolio was worth a day ago.",
      act: async h => { await h.spot(CARD(2)); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "Best today and worst today are the coins whose price rose the most and fell the most over the last day, with how much you hold of each in dollars.",
      act: async h => {
        await h.spot(CARD(3));
        await h.wait(1800);
        await h.spot(CARD(4));
        await h.wait(1800);
        await h.spot(null);
      },
    },
    {
      say: "And Largest position is your biggest holding by value, with its share of the whole portfolio.",
      act: async h => { await h.spot(CARD(5)); await h.wait(2500); await h.spot(null); },
    },
    {
      chapter: 'The assets table',
      say: "Below the cards is every asset you hold, one row each. Price is the current price, followed by how much it has moved over the last twenty-four hours and the last seven days.",
      act: async h => {
        await h.scrollTo('#holdings-count-title', { offset: 110 });
        await h.spot(ROW('BTC'));
        await h.hover(`${ROW('BTC')} td:nth-child(2)`);
        await h.wait(900);
        await h.hover(`${ROW('BTC')} td:nth-child(3)`);
        await h.wait(700);
        await h.hover(`${ROW('BTC')} td:nth-child(4)`);
        await h.wait(700);
        await h.spot(null);
      },
    },
    {
      say: "The seven-day trend is a small chart of the week, so you can see the shape of the move, not just where it ended. It's green when the week finished level or higher, and red when it finished lower.",
      act: async h => {
        await h.spot(`${ROW('BTC')} td.holdings-spark`);
        await h.wait(2000);
        await h.spot(`${ROW('AVAX')} td.holdings-spark`);
        await h.wait(1800);
        await h.spot(null);
      },
    },
    {
      say: "Amount is how many coins you hold. Value is what they're worth in dollars, and the next column is that value as a share of your whole portfolio.",
      act: async h => {
        await h.hover(`${ROW('ETH')} td:nth-child(6)`);
        await h.wait(900);
        await h.hover(`${ROW('ETH')} td:nth-child(7)`);
        await h.wait(900);
        await h.hover(`${ROW('ETH')} td:nth-child(8)`);
        await h.wait(700);
      },
    },
    {
      say: "Market cap is the value of every coin of that kind in existence, across the whole market, not just yours. The last column shows how far today's price sits below the coin's all-time high.",
      act: async h => {
        await h.hover(`${ROW('ETH')} td:nth-child(9)`);
        await h.wait(1600);
        await h.hover(`${ROW('ETH')} td:nth-child(10)`);
        await h.wait(1200);
      },
    },
    {
      say: "Cash balances, like dollars, are listed too. They count toward your total and your percentages, but there's no market data for them, so those columns stay empty.",
      act: async h => {
        await h.scrollTo(ROW('USD'), { within: TABLE, offset: 260, ms: 1400 });
        await h.spot(ROW('USD'));
        await h.wait(2800);
        await h.spot(null);
      },
    },
    {
      chapter: 'Sorting',
      say: "The table starts out sorted by value, biggest first. Click any column heading to sort by it instead. The arrow shows which column is doing the sorting.",
      act: async h => {
        await h.scroll(-6000, { within: TABLE, ms: 900 });
        await h.spot('#holdings-thead');
        await h.wait(1400);
        await h.click(TH('change24'));
        await h.wait(1200);
        await h.spot(null);
      },
    },
    {
      say: "Sorting by the twenty-four hour column puts today's strongest coins at the top. Click the same heading again to flip the order, and the weakest come first.",
      act: async h => {
        await h.wait(1200);
        await h.click(TH('change24'));
        await h.wait(1500);
      },
    },
    {
      say: "Sorting by the asset name runs from A to Z. Every other column starts with the largest number first. Anything without a figure in that column, like a cash balance, sinks to the bottom rather than being counted as zero.",
      act: async h => {
        await h.click(TH('asset'));
        await h.wait(1800);
        await h.click(TH('value'));
        await h.wait(900);
      },
    },
    {
      chapter: 'The full breakdown',
      say: "Select any row for the full breakdown of that coin. Let's open Bitcoin. Rows work from the keyboard too: tab to one and press Enter.",
      act: async h => {
        await h.click(ROW('BTC'));
        await h.settle(900);
        await h.scrollTo('#holdings-detail-section', { offset: 110 });
      },
    },
    {
      say: "Your position comes first: how much you hold, what it's worth, its share of your portfolio, and how many dollars it gained or lost in the last day. Held on lists each account the coin sits on, and how much is in each one.",
      act: async h => { await h.spot(BLOCK(1)); await h.wait(4500); await h.spot(null); },
    },
    {
      say: "Market size shows the coin's market cap and its rank, and its fully diluted valuation, which is what it would be worth if its maximum supply were already in circulation. Then the day's trading volume.",
      act: async h => { await h.spot(BLOCK(2)); await h.wait(4500); await h.spot(null); },
    },
    {
      say: "Volume divided by market cap shows how much of the coin changes hands in a day, with a plain-English reading, from thinly traded up to very actively traded.",
      act: async h => {
        await h.spot(`${BLOCK(2)} .holdings-stat:last-of-type`);
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Supply shows how many coins are circulating, how many have been issued, and the maximum that can ever exist, if there is one. The bar shows how much of that eventual supply is already out there, and the last line is your own share of it.",
      act: async h => { await h.spot(BLOCK(3)); await h.wait(5000); await h.spot(null); },
    },
    {
      say: "Price history gives you the day's range, the all-time high and when it happened, how far the price is from it now, and how much it would need to rise to get back there. The all-time low is at the bottom, with its date.",
      act: async h => { await h.spot(BLOCK(4)); await h.wait(5000); await h.spot(null); },
    },
    {
      say: "Momentum shows the price change over the last hour, day, week and month. The last line works out what your current holding would have been worth thirty days ago.",
      act: async h => { await h.spot(BLOCK(5)); await h.wait(4500); await h.spot(null); },
    },
    {
      say: "The last block comes from Kraken's public market data, whichever exchanges you use. It's the trading pair's own record on Kraken: its highest and lowest prices since Kraken has data for it, the fifty-two week range, the smallest order Kraken accepts, and Kraken's maker and taker fees.",
      act: async h => {
        await h.scrollTo(BLOCK(6), { offset: 160 });
        await h.spot(BLOCK(6));
        await h.wait(5500);
        await h.spot(null);
      },
    },
    {
      say: "To look at another coin, just select its row, and the breakdown switches over. When you're done, the cross closes it.",
      act: async h => {
        await h.scrollTo('#holdings-count-title', { offset: 110 });
        await h.click(ROW('ETH'));
        await h.settle(700);
        await h.scrollTo('#holdings-detail-section', { offset: 110 });
        await h.wait(600);
        await h.click('#holdings-detail-close');
        await h.wait(500);
      },
    },
    {
      chapter: 'Where the numbers come from',
      say: "Your balances and prices come from your exchanges. The market figures, like market cap, supply and all-time highs, come from CoinGecko's public data. Only the coin's ticker is sent, never your balances, and the figures are kept for ten minutes before being fetched again.",
      act: async h => {
        await h.scrollTo('.holdings-footnote', { offset: 300 });
        await h.spot('.holdings-footnote');
        await h.wait(5000);
        await h.spot(null);
      },
    },
    {
      say: "If CoinGecko can't be reached, a notice at the top of the page tells you that you're seeing the last figures Cyrus saved. Your balances and prices still come live from the exchange.",
      act: async h => { await h.scroll(-6000, { ms: 1200 }); },
    },
    {
      chapter: 'Wrapping up',
      say: "That's Holdings: the headline numbers, every coin side by side, and a full breakdown whenever you need one. Next, we'll look at your open orders.",
      act: async h => { await h.spot('#holdings-summary'); await h.wait(2500); await h.spot(null); },
    },
  ],
};
