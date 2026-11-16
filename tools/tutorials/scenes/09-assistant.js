// The AI assistant — the chat drawer opened from the top bar's Ask button or
// Ctrl+K. In demo mode AiData.ask/confirm are stubbed with canned replies
// (DemoData.assistantReply): any question mentioning "cancel" gets the
// two-order BTC/USD cancel proposal; anything else gets the biggest-positions
// answer. Nothing reaches Anthropic or an exchange.

const LAST_BOT = '#ai-body > .ai-msg-bot:not(.ai-thinking) >> nth=-1';

module.exports = {
  id: 'assistant',
  order: 9,
  title: 'The AI Assistant',
  subtitle: 'Ask about your portfolio in plain English, and approve what it does.',
  summary: 'Switching it on with your own Anthropic key, what it sees and sends, asking questions, approving cancels, orders and rules on a confirmation card, and conversation history.',
  steps: [
    {
      chapter: 'Introduction',
      say: "This video is about the assistant. It's a chat panel that answers questions about your portfolio, and can carry out tasks for you, like cancelling orders. It runs on Claude, Anthropic's AI model.",
      act: async h => { await h.spot('.tb-btn[data-ai-open]'); await h.wait(2500); await h.spot(null); },
    },
    {
      chapter: 'Switching it on',
      say: "The assistant is off until you give it your own Anthropic API key. You add that on your profile, under the Assistant tab.",
      act: async h => {
        await h.nav('profile');
        await h.click('.profile-tab[data-tab="assistant"]');
        await h.wait(500);
      },
    },
    {
      say: "Create a key in the Anthropic console, paste it here, and click Verify and Save. Cyrus checks it with Anthropic, then encrypts it like your exchange keys. Use is billed to your own Anthropic account, typically a fraction of a cent per question.",
      act: async h => {
        await h.spot('.ai-setup-card');
        await h.hover('#ai-key-input');
        await h.wait(1500);
        await h.hover('#ai-key-save');
        await h.wait(1500);
        await h.spot(null);
      },
    },
    {
      say: "One thing to know first: this is the one feature in Cyrus that sends portfolio data off your computer. When you ask a question, your holdings, rules, recent activity and resting orders go straight to Anthropic under your key, with no Cyrus server in between.",
      act: async h => { await h.spot('.ai-setup-card .card-lead'); await h.wait(4000); await h.spot(null); },
    },
    {
      say: "Your exchange keys are never part of that. This card sums up what to expect, and Remove key switches the assistant off again.",
      act: async h => {
        await h.spot('.ai-facts');
        await h.wait(2500);
        await h.spot(null);
        await h.hover('#ai-key-remove');
        await h.wait(800);
      },
    },
    {
      chapter: 'Opening the assistant',
      say: "Let's go to Limit Orders and open it. Click Ask in the top bar, or press Control and K on any page.",
      act: async h => {
        await h.nav('limitorders');
        await h.hover('.tb-btn[data-ai-open]');
        await h.wait(900);
        await h.press('Control+K');
        await h.wait(900);
      },
    },
    {
      say: "The panel slides in over whatever page you're on. Under its title is the Claude model it uses.",
      act: async h => { await h.spot('.ai-panel-head'); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "An empty conversation offers a few ideas. Click one, or type your own question at the bottom.",
      act: async h => {
        await h.spot('.ai-suggestions');
        await h.wait(2500);
        await h.spot(null);
        await h.hover('#ai-input');
      },
    },
    {
      chapter: 'Asking questions',
      say: "Let's ask what the biggest positions are.",
      act: async h => {
        await h.click('.ai-suggestion[data-q="What are my biggest positions?"]');
        await h.wait(1500);
      },
    },
    {
      say: "It leads with the answer, then the detail: Bitcoin is about a third of the portfolio, then Ethereum and Solana. Demo replies are prepared in advance. With your key, Claude answers from your real accounts.",
      act: async h => { await h.spot(LAST_BOT); await h.wait(4500); await h.spot(null); },
    },
    {
      say: "It knows what you hold on every exchange and what it's worth, this month's change, your automation rules and their recent activity, and your resting orders. So you can ask how the month has gone, or have it explain your automations.",
      act: async h => { await h.moveXY(1050, 300); await h.wait(1500); },
    },
    {
      say: "The first question after opening the panel fetches fresh balances. Follow-ups within a minute reuse them, so they're quicker.",
    },
    {
      say: "It won't tell you what to buy or sell; it lays out the facts instead. And like any AI, it can be wrong, so double-check anything that matters.",
      act: async h => { await h.spot('.ai-disclaimer'); await h.wait(3000); await h.spot(null); },
    },
    {
      chapter: 'Asking it to act',
      say: "It can also do things for you. Let's ask it to cancel the Bitcoin sell orders priced in dollars.",
      act: async h => {
        await h.type('#ai-input', 'Cancel my BTC/USD sell limit orders', { delay: 45 });
        await h.wait(300);
        await h.press('Enter');
        await h.wait(1500);
      },
    },
    {
      say: "Before acting, it looks up your orders and picks the ones that match. Here it found two, on Kraken and Robinhood, and left a Bitcoin to Tether order alone, because that isn't priced in dollars.",
      act: async h => { await h.spot(LAST_BOT); await h.wait(4500); await h.spot(null); },
    },
    {
      say: "Then it stops. Nothing has happened yet. This card lists exactly what it's about to do, built from the real values Cyrus will send, not from the AI's description of them.",
      act: async h => { await h.spot('.ai-confirm'); await h.wait(4500); },
    },
    {
      say: "Cancel turns it down, and nothing runs. Do it carries out every action on the card. If you ask something else instead, the card is dropped.",
      act: async h => {
        await h.hover('#ai-decline');
        await h.wait(1500);
        await h.hover('#ai-approve');
        await h.wait(1000);
        await h.spot(null);
      },
    },
    {
      say: "Limit orders and automation rules work the same way, and limit orders and withdraw rules are flagged in amber. Read rules twice: a rule fires later, on its own, perhaps while you're asleep.",
    },
    {
      say: "Everything goes through the same checks as the buttons in Cyrus. So it can't place a market order, and can only withdraw to an address you've already whitelisted on Kraken.",
    },
    {
      say: "Let's approve this one.",
      act: async h => { await h.click('#ai-approve'); await h.wait(1500); },
    },
    {
      say: "Each action reports back on its own. The Kraken order was cancelled. The Robinhood one had already filled, so the reason is shown right there, and the assistant explains it.",
      act: async h => {
        await h.spot('.ai-results');
        await h.wait(3000);
        await h.spot(LAST_BOT);
        await h.wait(2000);
        await h.spot(null);
      },
    },
    {
      chapter: 'History',
      say: "Conversations are saved as you go. The clock button shows your history.",
      act: async h => {
        await h.click('#ai-history');
        await h.wait(800);
        await h.spot('.ai-history');
        await h.wait(1500);
      },
    },
    {
      say: "History stays on this computer, separately for each account, and is never written to your Cyrus database. Click one to pick it up again, or delete one, or clear them all.",
      act: async h => {
        await h.hover('.ai-history-open');
        await h.wait(1200);
        await h.hover('.ai-history-del');
        await h.wait(1000);
        await h.hover('#ai-history-clear');
        await h.wait(800);
        await h.spot(null);
        await h.click('.ai-history-open');
        await h.wait(600);
      },
    },
    {
      say: "The pencil button starts a new conversation. The old one stays in your history.",
      act: async h => { await h.click('#ai-reset'); await h.wait(800); },
    },
    {
      chapter: 'Wrapping up',
      say: "Press Escape, or the cross, to close the panel. That's the assistant: ask in plain English, read the card, and approve only what you mean.",
      act: async h => {
        await h.hover('.ai-panel-actions [data-ai-close]');
        await h.wait(800);
        await h.press('Escape');
        await h.wait(800);
      },
    },
  ],
};
