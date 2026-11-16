// Automations — trigger and action rules, the rule builder, the execution log
// and the engine that runs them. Facts here are checked against
// src/backend/automation/worker.py and controllers/AutomationController.py.
//
// Demo mode stubs the rules list, the logs and the worker status, but NOT
// create / update / toggle / delete. So the rule builder is filled in and then
// closed, the edit dialog is cancelled, and pause / delete are only pointed at.

const TAB = t => `#rules-tab-strip button[data-tab="${t}"]`;
const ROW = id => `#rules-tbody tr:has([data-rule-id="${id}"])`;
const RADIO = (name, value) => `label.radio-label:has(input[name="${name}"][value="${value}"])`;

module.exports = {
  id: 'automations',
  order: 7,
  title: 'Automations',
  subtitle: 'Rules that watch your accounts and act for you, and how to check what they did.',
  summary: 'Triggers and actions, cooldowns and execution limits, the rule builder, the execution log, the engine status and email alerts.',
  setup: async h => { await h.nav('commands'); await h.settle(1200); },
  steps: [
    {
      chapter: 'Introduction',
      say: "This is the Automations page. An automation is a simple rule: when something happens, the trigger, Cyrus does something for you, the action. You set it up once, and Cyrus keeps watching.",
      act: async h => { await h.spot('.overview-header'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "The badge on the right is the automation engine. It checks all your rules about once a minute, and shows when it last finished a check.",
      act: async h => { await h.spot('#worker-status'); await h.hover('#worker-status'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "If checks run late, it turns amber. If the engine stops, it turns red, and nothing triggers until you restart Cyrus. It also flags a check that hit an error.",
      act: async h => { await h.spot('#worker-status'); await h.wait(3000); await h.spot(null); },
    },
    {
      say: "Rules only run while Cyrus is running. That's why closing the window keeps Cyrus in the system tray, or the menu bar on a Mac, instead of quitting.",
    },
    {
      say: "Each rule belongs to one exchange account. The Exchange menu chooses whose rules you see, and which account a new rule uses. Here, it's the Kraken account called Main.",
      act: async h => { await h.spot('.commands-exchange-selector-row'); await h.wait(3000); await h.spot(null); },
    },
    {
      chapter: 'What each exchange can do',
      say: "This table shows what each exchange supports. Every exchange can convert one coin into another. Withdrawing to a saved address needs API support, and today that's Kraken only.",
      act: async h => {
        await h.spot('.capabilities-section');
        await h.wait(2000);
        await h.hover('.capabilities-table tbody tr:nth-child(4)');
        await h.wait(1500);
        await h.spot(null);
      },
    },
    {
      say: "Once you know it, click the header to fold the table away.",
      act: async h => { await h.click('#capabilities-toggle'); await h.wait(900); },
    },
    {
      chapter: 'Your automations',
      say: "The Flow tab draws your automations as a map. Each circle is a coin, and each line is a rule moving money onward, or out to a withdrawal wallet. Dashed circles belong to paused rules.",
      act: async h => {
        await h.scrollTo('#rules-count-title', { offset: 90 });
        await h.spot('#rules-flow-chart');
        await h.wait(2500);
        await h.hover('#rules-flow-chart .rf-node.rf-paused');
        await h.wait(1200);
        await h.spot(null);
      },
    },
    {
      say: "Hover a circle to read, in plain English, what its rules will do. Click it to edit, and if several rules start there, Cyrus asks which one.",
      act: async h => { await h.hover('#rules-flow-chart .rf-node[data-key$="A:SOL"]'); await h.wait(2800); },
    },
    {
      say: "The Rules tab lists the same automations as a table: name, trigger, action, whether it's active or paused, and how often it has fired.",
      act: async h => {
        await h.moveXY(700, 120);
        await h.click(TAB('table'));
        await h.wait(600);
        await h.spot('#rules-table-view');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Triggered counts every time a rule fired. For price rules, Success counts how many of those went through, against the limit you set.",
      act: async h => { await h.spot(ROW(5002)); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "On the right, the pencil edits a rule, pause stops it being checked while keeping its settings, play resumes it, and the bin deletes it.",
      act: async h => {
        await h.spot(`${ROW(5002)} .controls-cell`);
        await h.hover(`#rules-tbody button[data-action="edit"][data-rule-id="5002"]`, 600);
        await h.wait(700);
        await h.hover(`#rules-tbody button[data-action="toggle"][data-rule-id="5002"]`, 500);
        await h.wait(900);
        await h.hover(`#rules-tbody button[data-action="delete"][data-rule-id="5002"]`, 500);
        await h.wait(700);
        await h.spot(null);
      },
    },
    {
      say: "Allocation rules come from the Balancer page. They're listed here so you see everything in one place, and editing one takes you to the Balancer.",
      act: async h => { await h.scrollTo(ROW(6001)); await h.spot(ROW(6001)); await h.wait(3500); await h.spot(null); },
    },
    {
      chapter: 'Building a rule',
      say: "Now let's build one. Click New Automation. The builder has three steps: when, then, and review.",
      act: async h => {
        await h.scrollTo('#rules-count-title', { offset: 90 });
        await h.click('#new-automation-btn');
        await h.wait(700);
        await h.spot('#wizard-progress');
        await h.wait(1500);
        await h.spot(null);
      },
    },
    {
      say: "First, the trigger. There are three: an order is filled, a balance reaches a threshold, or a price reaches a target.",
      act: async h => { await h.spot('#trigger-type'); await h.wait(2500); await h.spot(null); },
    },
    {
      say: "An order trigger watches one of your open orders. When it leaves your open orders, Cyrus looks it up, and the rule only runs if the order actually filled. Cancelling it won't set the rule off.",
      act: async h => {
        await h.select('#trigger-order-id', 'O9SBUD-ZJ3L5-ATO11');
        await h.spot('#trigger-order-section');
        await h.wait(3500);
        await h.spot(null);
      },
    },
    {
      say: "A balance trigger fires when your balance of a coin is at or above the amount you set. It's handy for sweeping up a coin that builds up, like staking rewards.",
      act: async h => {
        await h.select('#trigger-type', 'balance_threshold');
        await h.settle(700);
        await h.select('#trigger-asset', 'DOT');
        await h.type('#trigger-threshold', '2500');
        await h.wait(600);
      },
    },
    {
      say: "Balance and price rules also have a cooldown, the shortest gap between two runs: at least a minute, and a day to start with. Without it, a balance that stays high would fire on every check.",
      act: async h => { await h.spot('#cooldown-section'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "The third trigger is a price target. Pick a coin, and a price in US dollars, USDT or USDC. The rule fires when the price is at or above your target, so it's made for taking profit.",
      act: async h => {
        await h.select('#trigger-type', 'price_threshold');
        await h.settle(900);
        await h.select('#price-trigger-asset', 'SOL');
        await h.type('#price-trigger-threshold', '85');
        await h.select('#price-quote-asset', 'USD');
      },
    },
    {
      say: "Prices can spike and fall back between checks. So rather than only the price at that moment, Cyrus reads the short price candles since its last check, and uses the highest price reached.",
      act: async h => { await h.spot('#trigger-price-section'); await h.wait(3500); await h.spot(null); },
    },
    {
      say: "Note that the sale is a market order at the price when Cyrus acts, which can be below that peak. And where an exchange has no candle data, it uses the current price.",
    },
    {
      say: "Click Next for the action. A price rule always converts the coin it watches. Choose what into, and how much each time: all of it, a percentage of your balance at that moment, or a fixed amount.",
      act: async h => {
        await h.click('#wizard-next');
        await h.wait(500);
        await h.select('#price-convert-to-asset', 'USDC');
        await h.click(RADIO('price-amount-mode', 'percent'));
        await h.type('#price-amount-value', '50');
      },
    },
    {
      say: "The execution limit caps how many times the rule may succeed. Untick Unlimited and enter a number. When it's reached, Cyrus pauses the rule and notes it in the log. Failed attempts don't count.",
      act: async h => {
        await h.click('label:has(#price-unlimited)');
        await h.type('#price-max-executions', '2');
        await h.spot('#price-execution-limit-row');
        await h.wait(2200);
        await h.spot(null);
      },
    },
    {
      say: "Step three: name the rule, then read the summary. It spells the whole rule out in one sentence, so you can check it before anything is saved.",
      act: async h => {
        await h.click('#wizard-next');
        await h.wait(500);
        await h.type('#rule-name', 'Take profit on SOL');
        await h.spot('#rule-summary');
        await h.wait(2500);
        await h.spot(null);
      },
    },
    {
      say: "Create Automation would save it, and it's checked from the next cycle on. We'll close this one without saving.",
      act: async h => {
        await h.hover('#create-rule-btn');
        await h.wait(1000);
        await h.click('#create-rule-modal-close');
        await h.wait(500);
      },
    },
    {
      chapter: 'Withdraw and convert actions',
      say: "Order and balance triggers can either withdraw or convert. Let's set up an order rule to see both, on a buy order for ATOM.",
      act: async h => {
        await h.click('#new-automation-btn');
        await h.wait(600);
        await h.select('#trigger-order-id', 'O9SBUD-ZJ3L5-ATO11');
        await h.wait(500);
        await h.click('#wizard-next');
        await h.wait(400);
        await h.select('#action-type', 'withdraw_crypto');
      },
    },
    {
      say: "Withdraw sends coins to an address you've already whitelisted on the exchange. The coin is whatever the order brings in: for a buy, the coin you bought, and for a sell, the currency you're paid in.",
      act: async h => {
        await h.select('#action-address-key', 'atom_keplr');
        await h.spot('#withdraw-fields');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Send a fixed amount, or, for a buy order, exactly the amount that filled. Cyrus also knows each coin's minimum withdrawal, plus a small safety margin, and won't try to send less.",
      act: async h => {
        await h.click(RADIO('amount-mode', 'filled'));
        await h.spot('#amount-mode-section');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "Convert swaps the coin for another with a market order. Leave the amount empty, and it converts your whole available balance of that coin, not just what this order brought in.",
      act: async h => {
        await h.select('#action-type', 'convert_crypto');
        await h.wait(400);
        await h.select('#convert-to-asset', 'USDC');
        await h.spot('#wizard-step-then');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "We'll close this one too.",
      act: async h => { await h.click('#create-rule-modal-close'); await h.wait(500); },
    },
    {
      chapter: 'Editing a rule',
      say: "To change a rule, click its pencil. You can always rename it and change its execution limit, and depending on the trigger, its price or threshold, cooldown, amount or address.",
      act: async h => {
        await h.click(`#rules-tbody button[data-action="edit"][data-rule-id="5002"]`);
        await h.wait(700);
        await h.spot('#edit-rule-modal');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "The trigger type and the coin it watches are fixed. To change those, make a new rule. Cancel closes this without changes.",
      act: async h => { await h.wait(1500); await h.click('#edit-rule-cancel'); await h.wait(500); },
    },
    {
      chapter: 'The execution log',
      say: "The Log tab is the history of every run: when it happened, what triggered it, what Cyrus did, and the result.",
      act: async h => {
        await h.click(TAB('log'));
        await h.wait(600);
        await h.spot('#rules-log-view');
        await h.wait(2800);
        await h.spot(null);
      },
    },
    {
      say: "Success means the trade or withdrawal went through. Error means it was tried and failed, and the result says why. Skipped means the rule was checked but didn't act.",
      act: async h => {
        await h.select('#commands-exchange-selector', { label: 'Trading' });
        await h.settle(900);
        await h.spot('#logs-tbody tr:has(.status-error)');
        await h.wait(2200);
        await h.spot(null);
      },
    },
    {
      say: "A skip always gives the reason: a price that hasn't reached its target, with the highest price seen, a coin under its cap, or a rule waiting out its cooldown.",
      act: async h => {
        await h.spot('#logs-tbody tr:has(.status-skipped)');
        await h.wait(3000);
        await h.spot(null);
      },
    },
    {
      say: "A rule that keeps skipping for the same reason writes one line, not one a minute. A new line appears when the reason changes, or when the rule runs.",
    },
    {
      say: "One safety detail. Cyrus records that a rule has fired before it contacts the exchange. That starts the cooldown, so if something fails partway, a balance or price rule won't fire again a minute later and double up.",
    },
    {
      say: "If an exchange is busy or limiting requests, Cyrus simply tries again on the next check.",
    },
    {
      chapter: 'Email alerts',
      say: "For email alerts, turn on Email Me on Execution in your Profile. Each time a rule goes through, you'll get the rule, the time, the trigger, the action and the exchange's result.",
      act: async h => { await h.hover('.nav-link[data-route="profile"]'); await h.wait(2500); await h.moveXY(700, 300); },
    },
    {
      say: "If an email can't be sent, the trade still goes ahead, and the log still records it.",
    },
    {
      chapter: 'Wrapping up',
      say: "That's Automations. A good first step is one price rule with an execution limit of one, then watch the log. Next, the Balancer.",
      act: async h => {
        await h.select('#commands-exchange-selector', { label: 'Main' });
        await h.settle(700);
        await h.click(TAB('flow'));
        await h.wait(800);
      },
    },
  ],
};
