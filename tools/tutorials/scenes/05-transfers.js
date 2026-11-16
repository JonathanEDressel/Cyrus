// Transfers — deposit and withdrawal history, the roadmap, self-transfer
// matching, and tracked wallets.
//
// Demo-mode notes: Same / Not the same are no-ops (the fixture never changes),
// and the wallet template / import throw, so those are hovered and explained
// rather than clicked. Wallets are typed into but never saved.

const HOP = text => `.roadmap-hop:has-text("${text}")`;
const SUGGESTED = '.roadmap-hop:has(.roadmap-suggestion)';

module.exports = {
  id: 'transfers',
  order: 5,
  title: 'Transfers',
  subtitle: 'Where your money went, and which moves were between your own accounts.',
  summary: 'Transfer history from every exchange, the roadmap, how Cyrus pairs moves between your own exchanges, reviewing suggested matches, and labelling your wallets.',
  setup: async h => { await h.nav('transfers'); await h.settle(1200); },
  steps: [
    {
      chapter: 'Introduction',
      say: "This is the Transfers page. It brings together every deposit and withdrawal across your connected exchanges, and works out where your money actually went.",
      act: async h => { await h.spot('.transfers-page .overview-header'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "Cyrus fetches this history from each exchange and keeps a copy on your computer, so the page opens instantly. Your first visit pulls everything automatically. After that, the refresh button fetches anything new.",
      act: async h => {
        await h.spot('#transfers-refresh');
        await h.wait(1500);
        await h.click('#transfers-refresh');
        await h.wait(1500);
        await h.spot(null);
      },
    },
    {
      say: "If an exchange can't provide this history, Cyrus says so. Robinhood doesn't offer it, so nothing from Robinhood appears here. A key that's missing the permission to read funding history gets a notice too.",
      act: async h => { await h.spot('#transfers-unsupported'); await h.wait(3500); await h.spot(null); },
    },
    {
      chapter: 'The roadmap',
      say: "The page opens on the Roadmap. It shows each movement once, newest first and grouped by day, with where the money came from on the left and where it went on the right.",
      act: async h => { await h.spot('.roadmap-hop'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "A red edge means money left one of your exchanges, and green means money arrived. The summary line counts what's been paired, what's waiting for your review, and what has an end Cyrus can't identify.",
      act: async h => {
        await h.moveXY(140, 380);
        await h.wait(1600);
        await h.spot('#transfers-match-summary');
        await h.wait(2800);
        await h.spot(null);
      },
    },
    {
      chapter: 'Matching your own transfers',
      say: "When you move coins between exchanges, one reports a withdrawal and the other reports a deposit, as two unrelated events. Cyrus joins them back together, so this move from Binance to Kraken shows as one hop with both ends named.",
      act: async h => {
        await h.scrollTo('.roadmap-hop-internal:has-text("SOL")', { offset: 200 });
        await h.spot('.roadmap-hop-internal:has-text("SOL")');
        await h.wait(4000);
        await h.spot(null);
      },
    },
    {
      say: "Same transaction means both exchanges reported the same on-chain transaction, so the match is certain. The small amount lost on the way is shown as the network fee, with how long the coins took to arrive.",
      act: async h => {
        await h.spot('.roadmap-hop-internal:has-text("SOL") .roadmap-meta');
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "Without a shared transaction, Cyrus compares the amount and the timing. It looks for the same coin on two different exchanges, with the deposit landing within three days and no more than a few percent smaller, to allow for fees. The result is shown as a score.",
      act: async h => {
        await h.scrollTo('.roadmap-hop-internal:has-text("ADA")', { offset: 220 });
        await h.spot('.roadmap-hop-internal:has-text("ADA")');
        await h.wait(4500);
        await h.spot(null);
      },
    },
    {
      say: "Cyrus only pairs these by itself when it's at least ninety-five percent sure, and no other transfer could plausibly be the partner. When candidates compete, it leaves the decision to you.",
      act: async h => {
        await h.spot('.roadmap-hop-internal:has-text("ADA") .roadmap-badge');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      chapter: 'Reviewing suggested matches',
      say: "Anything less certain becomes a question for you. This Tether withdrawal from Kraken looks like the same movement as a slightly smaller deposit on Binance, and Cyrus is ninety-one percent confident.",
      act: async h => {
        await h.scrollTo(SUGGESTED, { offset: 160 });
        await h.spot(`${SUGGESTED} .roadmap-suggestion`);
        await h.wait(3800);
        await h.spot(null);
      },
    },
    {
      say: "If it's right, click Same. The pair is confirmed, and locked so that later syncs never undo your decision.",
      act: async h => { await h.hover('[data-confirm-w]'); await h.wait(2000); },
    },
    {
      say: "If it's wrong, click Not the same. Cyrus remembers that answer, so it won't suggest the pair again, and both transfers are free to match something else.",
      act: async h => { await h.hover('[data-reject-w]'); await h.wait(2000); },
    },
    {
      say: "This matters for your taxes. A confirmed pair carries the coins' original cost and purchase date over to the new exchange. Leave it unconfirmed, and the deposit on Binance looks like coins from outside, with no known cost.",
      act: async h => { await h.spot(SUGGESTED); await h.wait(3500); await h.spot(null); },
    },
    {
      chapter: 'Wallets and unknown ends',
      say: "Some transfers have only one side in your exchange data, because the other end is a wallet. When you've labelled that wallet, the hop names it, like this Bitcoin sent from Coinbase to My Ledger.",
      act: async h => {
        await h.scrollTo(HOP('My Ledger'), { offset: 200 });
        await h.spot(HOP('My Ledger'));
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "A labelled wallet doesn't have to be yours. This rent payment goes to someone else's address, shown with a person icon instead of a wallet.",
      act: async h => { await h.spot(HOP('Rent (not mine)')); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "And when Cyrus doesn't know, it says so. This deposit came with no address, so it reads Unknown source rather than guessing. For a genuine payment from outside, there's nothing to fix.",
      act: async h => {
        await h.scrollTo(HOP('Unknown source'), { offset: 260 });
        await h.spot(HOP('Unknown source'));
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "When the exchange did report an address, the unknown end becomes a button. Click name it to label that address.",
      act: async h => {
        await h.scrollTo('.roadmap-label-btn', { offset: 220 });
        await h.spot('.roadmap-label-btn');
        await h.wait(1500);
        await h.spot(null);
        await h.click('.roadmap-label-btn');
        await h.settle(800);
      },
    },
    {
      chapter: 'Tracked wallets',
      say: "That opens Tracked wallets, with the address already filled in. Label an address once, and every transfer to or from it is attributed, past and future.",
      act: async h => {
        await h.spot('#wallets-overlay .form-group:has(#wallet-address)');
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "Give it a name you'll recognise. The chain, a memo or tag for coins like Stellar and XRP, the asset, and notes are all optional.",
      act: async h => {
        await h.type('#wallet-label', 'Trust Wallet');
        await h.wait(600);
        await h.hover('#wallet-tag');
        await h.wait(800);
      },
    },
    {
      say: "Leave This wallet is mine ticked for your own wallets. Only those turn a transfer into a move between your own accounts. Untick it for someone else's address that you just want to recognise. Then click Add wallet.",
      act: async h => {
        await h.spot('#wallets-overlay label.radio-label');
        await h.wait(3500);
        await h.spot(null);
        await h.hover('#wallet-save');
        await h.wait(800);
      },
    },
    {
      say: "Seen in your transfers lists addresses already in your history that aren't labelled yet. Click one and it fills in the form for you. It's the quickest way to get started.",
      act: async h => {
        await h.spot('#wallets-suggestions-block');
        await h.wait(1800);
        await h.spot(null);
        await h.click('.wallet-suggestion');
        await h.wait(1000);
      },
    },
    {
      say: "With more than a few wallets, use Add several at once. Download the template, fill in one row per wallet, and import it back. Cyrus previews what will be added or skipped before anything is saved. Export saved gives you your current list in the same format.",
      act: async h => { await h.spot('#wallets-overlay .wallets-import'); await h.wait(4500); await h.spot(null); },
    },
    {
      say: "Saved wallets lists everything you've labelled, and how many transfers each one explains. You can edit or remove them here. Removing one returns its transfers to an unknown address.",
      act: async h => {
        await h.spot('#wallets-list');
        await h.wait(3500);
        await h.spot(null);
        await h.click('#wallets-done');
        await h.wait(500);
      },
    },
    {
      chapter: 'The table and filters',
      say: "For the raw records, switch to Table. Each deposit and withdrawal is a row, with the exchange, the type, the coin, the amount and fee, the status, the time, and the transaction ID.",
      act: async h => {
        await h.scroll(-5000, { ms: 1200 });
        await h.click('button[data-view="table"]');
        await h.settle(700);
        await h.spot('#transfers-table thead');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Status shows whether a transfer is complete, pending, or failed. Failed and canceled transfers never moved any money, so they're never matched or counted in your cost basis. Internal marks a move between your own accounts on the same exchange.",
      act: async h => {
        await h.spot('#transfers-tbody tr:has(.transfers-status-pending)');
        await h.wait(1600);
        await h.scrollTo('#transfers-tbody tr:has(.transfers-status-bad)', { offset: 300 });
        await h.spot('#transfers-tbody tr:has(.transfers-status-bad)');
        await h.wait(2000);
        await h.scrollTo('#transfers-tbody tr:has(.transfers-tag)', { offset: 300 });
        await h.spot('#transfers-tbody tr:has(.transfers-tag)');
        await h.wait(2000);
        await h.spot(null);
      },
    },
    {
      say: "The filters narrow the table to one exchange account, or to just deposits or withdrawals, and the count updates to match. Long histories are split into pages of a hundred.",
      act: async h => {
        await h.scroll(-5000, { ms: 1000 });
        await h.select('#transfers-connection', { label: 'Main' });
        await h.wait(900);
        await h.select('#transfers-kind', 'withdrawal');
        await h.wait(900);
        await h.spot('#transfers-count-title');
        await h.wait(1600);
        await h.spot(null);
        await h.select('#transfers-kind', '');
        await h.select('#transfers-connection', 'all');
      },
    },
    {
      say: "The asset filter works in both views. Back on the Roadmap, choose Bitcoin, and you can trace exactly where your Bitcoin has been.",
      act: async h => {
        await h.click('button[data-view="roadmap"]');
        await h.settle(600);
        await h.select('#transfers-asset', 'BTC');
        await h.settle(700);
        await h.spot('#transfers-roadmap');
        await h.wait(3000);
        await h.spot(null);
        await h.select('#transfers-asset', '');
        await h.settle(500);
      },
    },
    {
      chapter: 'Wrapping up',
      say: "That's Transfers. Keep your history synced, answer the matches Cyrus suggests, and label the wallets you own. Every movement you settle here makes the cost basis on the Taxes page more complete.",
      act: async h => { await h.hover('.nav-link[data-route="taxes"]'); await h.wait(1200); },
    },
  ],
};
