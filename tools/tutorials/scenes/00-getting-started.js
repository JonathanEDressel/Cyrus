// Getting started — the first video. A quick look at the layout, then the
// Profile page: connecting exchanges (with the permissions each one needs),
// the assistant key, notifications, email and the monthly report, and the
// account settings.
//
// Adding or testing a connection is not stubbed in demo mode, so the form is
// filled with placeholder text and then cleared. Nothing is ever submitted.

const TAB = name => `.profile-tab[data-tab="${name}"]`;
const ADD_CARD = '.profile-card:has(#add-connection-form)';
const EMAIL_CARD = '.profile-card:has(#email-settings-form)';
const REPORT_CARD = '.profile-card:has(#test-report-btn)';

module.exports = {
  id: 'getting-started',
  order: 0,
  title: 'Getting Started',
  subtitle: 'Connect your exchanges and set up your profile.',
  summary: 'A tour of the layout, connecting Kraken, Coinbase, Binance, Gemini and Robinhood with the right API permissions, and every setting on the Profile page.',
  steps: [
    {
      chapter: 'Introduction',
      say: "Welcome to Cyrus. In this first video, we'll find our way around, connect an exchange, and go through your profile settings. Everything here is demo data, not a real account.",
    },
    {
      say: "Down the left side is the page rail: your portfolio pages at the top, then Automations and the Balancer, and your Profile at the bottom.",
      act: async h => { await h.spot('#header-nav'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "Across the top, the search box jumps to any page. The exchange selector chooses between all your accounts combined, or just one.",
      act: async h => {
        await h.spot('#command-search-wrap');
        await h.wait(1600);
        await h.spot('#exchange-selector-wrapper');
        await h.wait(2000);
        await h.spot(null);
      },
    },
    {
      say: "The worker pill shows the automation engine is running, and Ask opens the AI assistant, which has its own video.",
      act: async h => {
        await h.spot('#worker-pill');
        await h.wait(1800);
        await h.spot('.tb-btn[data-ai-open]');
        await h.wait(1800);
        await h.spot(null);
      },
    },
    {
      chapter: 'Exchange connections',
      say: "Setting up starts on your profile, at the bottom of the rail.",
      act: async h => { await h.nav('profile'); },
    },
    {
      say: "At the top, a chip shows how many exchanges are connected, and warns you if any haven't been validated.",
      act: async h => { await h.spot('.profile-hero'); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "Settings are split into four tabs. Let's start with the one that matters most, Exchanges.",
      act: async h => {
        await h.spot('#profile-tabs');
        await h.wait(2200);
        await h.spot(null);
        await h.click(TAB('exchanges'));
        await h.wait(600);
      },
    },
    {
      say: "Each card is one connection: the exchange, your label for it, and whether its keys are validated.",
      act: async h => { await h.spot('#connections-list'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "Test checks the keys by asking the exchange for your balance. If that works, the connection is marked validated. If the keys are rejected, it's marked not validated.",
      act: async h => {
        await h.spot('.connection-card');
        await h.hover('.connection-card [data-action="validate"]');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "The bin removes a connection and its stored keys.",
      act: async h => { await h.hover('.connection-card [data-action="delete"]'); await h.wait(1200); },
    },
    {
      chapter: 'Adding a connection',
      say: "To connect an account, scroll down to Add a connection and choose the exchange. A question mark appears, linking to that exchange's guide to creating API keys.",
      act: async h => {
        await h.scrollTo(ADD_CARD);
        await h.spot(ADD_CARD);
        await h.wait(900);
        await h.select('#new-exchange-name', 'kraken');
        await h.wait(700);
        await h.hover('#exchange-guide-link');
        await h.wait(1200);
        await h.spot(null);
      },
    },
    {
      say: "The label tells your accounts apart, because you can connect the same exchange more than once. Let's call this one Long term.",
      act: async h => { await h.type('#new-connection-label', 'Long term'); await h.wait(400); },
    },
    {
      say: "Just make sure each one is a different account. Connections are added together, so the same account twice would count double, and reusing keys is blocked.",
      act: async h => { await h.spot('.dupe-warning'); await h.wait(3500); await h.spot(null); },
    },
    {
      chapter: 'Which permissions to grant',
      say: "Next, create an API key on the exchange, with only what Cyrus needs. On Kraken: query funds, query open and closed orders and trades, and create, modify and cancel orders.",
      act: async h => { await h.spot('.form-group:has(#new-api-key)'); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "Only add withdraw funds if you plan to use withdraw rules. Kraken is the only exchange Cyrus can withdraw from, and only to addresses you've whitelisted there.",
      act: async h => { await h.hover('#new-exchange-name'); await h.wait(1500); },
    },
    {
      say: "For Coinbase, create the key in Coinbase Advanced, not the standard app, with view and trade permissions.",
      act: async h => { await h.select('#new-exchange-name', 'coinbase'); await h.wait(800); },
    },
    {
      say: "On Binance, enable reading and spot trading, and leave withdrawals off.",
      act: async h => { await h.select('#new-exchange-name', 'binance'); await h.wait(800); },
    },
    {
      say: "On Gemini, use the Trader role, Gemini's default. Gemini also has a sandbox, a practice exchange with fake funds, so a sandbox option appears.",
      act: async h => {
        await h.select('#new-exchange-name', 'gemini');
        await h.wait(600);
        await h.spot('#sandbox-group');
        await h.wait(2000);
        await h.spot(null);
      },
    },
    {
      say: "Tick it only if your key came from Gemini's sandbox site. Cyrus then connects to the test exchange instead of the real one.",
      act: async h => {
        await h.click('#new-is-sandbox');
        await h.wait(1500);
        await h.click('#new-is-sandbox');
        await h.wait(400);
      },
    },
    {
      say: "Robinhood doesn't give you a secret. Instead, you create a pair of keys, give Robinhood the public half, and it gives you an API key.",
      act: async h => {
        // The harness's bridge stubs saveKeygenScript, so the generator panel
        // shows; its download button is never clicked.
        await h.select('#new-exchange-name', 'robinhood');
        await h.wait(500);
        await h.spot('#keygen-panel');
        await h.wait(2500);
      },
    },
    {
      say: "Cyrus offers a small key generator for that. It needs Python 3, works offline, and prints both keys. The private one goes in the field below.",
      act: async h => {
        await h.hover('#keygen-download-btn');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Whichever exchange it is, paste the API key and secret here. Both stay hidden as you type.",
      act: async h => {
        await h.scrollTo('.form-group:has(#new-api-key)', { offset: 300 });
        await h.type('#new-api-key', 'your-api-key', { delay: 50 });
        await h.type('#new-private-key', 'your-secret', { delay: 50 });
      },
    },
    {
      say: "When you click Add Connection, the keys are encrypted and saved on your own computer. They're only decrypted when Cyrus talks to that exchange, and never sent anywhere else.",
      act: async h => {
        await h.spot('#add-connection-form .card-foot');
        await h.hover('#add-connection-btn');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Cyrus tests the new connection straight away, and once it's validated it appears across the app. This is a demo, so we'll clear the form instead.",
      act: async h => {
        await h.wait(2500);
        await h.eval(() => {
          const sel = document.getElementById('new-exchange-name');
          sel.selectedIndex = 0;
          sel.dispatchEvent(new Event('change'));
          for (const id of ['new-connection-label', 'new-api-key', 'new-private-key', 'new-passphrase']) {
            const el = document.getElementById(id);
            if (el) el.value = '';
          }
          const sandbox = document.getElementById('new-is-sandbox');
          if (sandbox) sandbox.checked = false;
        });
        await h.wait(500);
      },
    },
    {
      chapter: 'Stock charts',
      say: "Further down, Stock market data is optional. Add a free Alpaca key here, and the Charts page can show US stocks and ETFs as well as crypto. The Charts video covers it.",
      act: async h => {
        await h.scrollTo('#stocks-card');
        await h.spot('#stocks-card');
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      chapter: 'The assistant key',
      say: "The Assistant tab switches on the AI assistant. It's off until you add your own Anthropic API key, which Cyrus checks with Anthropic and encrypts like your exchange keys.",
      act: async h => {
        await h.scroll(-3000, { ms: 900 });
        await h.click(TAB('assistant'));
        await h.wait(500);
        await h.spot('.ai-setup-card');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "It's the one feature that sends portfolio data off your computer, straight to Anthropic under your key. The assistant video covers it in detail.",
      act: async h => { await h.spot('.ai-facts'); await h.wait(3000); await h.spot(null); },
    },
    {
      chapter: 'Notifications and email',
      say: "On Notifications, desktop notifications tell you when an automation rule runs. The second switch hides the support button in the corner.",
      act: async h => {
        await h.click(TAB('notifications'));
        await h.wait(500);
        await h.spot('.profile-card:has(#notifications-toggle)');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Cyrus can also email you when a rule executes, sent from your own email account. Turn on Email Me on Execution and enter your address.",
      act: async h => {
        await h.spot(EMAIL_CARD);
        await h.hover('label.toggle-switch:has(#email-notifications-toggle)');
        await h.wait(800);
        await h.type('#email-address', 'you@example.com', { delay: 45 });
        await h.wait(400);
      },
    },
    {
      say: "For the password, use an app password from your email provider's security settings, not your normal one. The link underneath shows how.",
      act: async h => {
        await h.hover('#email-app-password');
        await h.wait(1600);
        await h.hover('#email-settings-form .form-hint .inline-link');
        await h.wait(1000);
      },
    },
    {
      say: "For Gmail, Outlook, Yahoo, iCloud and other common providers, the mail server is filled in for you. Otherwise, enter it here.",
      act: async h => { await h.spot('.form-group:has(#email-smtp-host)'); await h.wait(2800); },
    },
    {
      say: "Send Test checks the form before you save. Emails only go out while Cyrus is running.",
      act: async h => {
        await h.spot(null);
        await h.hover('#test-email-btn');
        await h.wait(1500);
        await h.hover('#save-email-btn');
        await h.wait(800);
      },
    },
    {
      say: "Once email is on and saved, you also get a monthly report: your holdings, that month's automation log, and where your rules and orders move money. If Cyrus was closed at month end, it goes out next time it runs.",
      act: async h => {
        await h.scrollTo(REPORT_CARD, { offset: 300 });
        await h.spot(REPORT_CARD);
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "Send Test Report emails you one right away, without counting as that month's report.",
      act: async h => {
        await h.hover('#test-report-btn');
        await h.wait(1200);
        await h.eval(() => { const el = document.getElementById('email-address'); if (el) el.value = ''; });
      },
    },
    {
      chapter: 'Account settings',
      say: "Finally, the Account tab, for your username and password.",
      act: async h => {
        await h.scroll(-3000, { ms: 900 });
        await h.click(TAB('account'));
        await h.wait(500);
        await h.spot('.profile-pane[data-pane="account"] .profile-grid');
        await h.wait(2200);
        await h.spot(null);
      },
    },
    {
      say: "Dark Mode switches between the dark and light themes.",
      act: async h => {
        await h.click('label.toggle-switch:has(#theme-toggle)');
        await h.wait(1600);
        await h.click('label.toggle-switch:has(#theme-toggle)');
        await h.wait(600);
      },
    },
    {
      say: "Account Active is a master switch. Turn it off, and automations and exchange features stop until you turn it back on.",
      act: async h => {
        await h.spot('.setting-toggle-row:has(#active-toggle)');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      chapter: 'Wrapping up',
      say: "That's it: connect an exchange, test it, and set up the extras you want. Everything is stored in one database file on your own computer. Next, a tour of the Overview.",
      act: async h => { await h.click(TAB('exchanges')); await h.wait(800); },
    },
  ],
};
