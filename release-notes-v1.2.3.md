## What's New in v1.2.3

Two new pages: one that keeps any single coin from quietly taking over your portfolio, and one that tells you what you actually own.

### ✨ Portfolio Balancer

A new **Balancer** page where you set a ceiling on how much of your portfolio each coin is allowed to become. When a holding grows past its cap, Cyrus sells the excess into an asset you choose and stops.

- **Drag the caps directly on the chart.** Every holding is a bar showing its current share of the account; drag the handle above a bar to set its maximum, or type an exact figure in the table below. The bar turns amber when a coin has reached its cap.
- **Each position converts into an asset you pick** — a stablecoin, BTC, ETH, whatever the exchange has a market for. Destinations that aren't tradable on your exchange are rejected when you save, not silently at 3am.
- **It sells only the excess.** You set a maximum and a "down to" level, and a rebalance lands on the lower one. Selling exactly back to the cap would leave the position sitting on its trigger and firing again every cycle.
- **Simulate-only mode** logs what it *would* have traded without placing an order. Worth leaving on until you've watched it run once.
- **A minimum trade size** (default $25) stops the balancer placing dust orders the exchange would reject anyway, and a cooldown keeps a choppy market from triggering repeat trades.

Balancer rules appear in the Automations list and log like any other rule, and are covered by your email alerts if you have them switched on.

**Supported on Kraken, Coinbase Advanced, Binance and Robinhood** — anywhere Cyrus can price your holdings and place a market order.

### ✨ Holdings

A new **Holdings** page showing what's behind each coin you own, not just its price.

- **Sortable table** of every position: price, 1h/24h/7d moves, a 7-day trend line, your amount and value, share of portfolio, market cap, and how far the coin sits below its all-time high.
- **Summary across the top** — total value, the last 24 hours **in dollars as well as percent**, your best and worst performers, and your largest position.
- **Select any row** for the full breakdown: market cap and rank, fully diluted valuation, 24h volume with a plain-English liquidity read, circulating vs. maximum supply with how much of the eventual supply already exists, all-time high and low with dates, the gain it would take to get back to that high, and momentum over 1h/24h/7d/30d.
- **Your position in context** — what the last day did to it in dollars, what it was worth 30 days ago, your share of the coin's circulating supply, and which exchanges hold it when a coin is spread across more than one.
- **Exchange history** from Kraken's public data: highest and lowest ever for the pair, the 52-week range, minimum order size and fees — reported separately from the coin's all-time high, because an exchange's record only starts when it listed the pair.

Market cap, supply and all-time highs come from CoinGecko's free public API. **Only the coin's ticker is ever sent — never your balances, amounts, or anything identifying you.** Figures are cached for ten minutes, and if the provider is unreachable the page falls back to the last cached numbers and tells you how old they are; your balances and prices stay live from your exchange throughout.

### ⚡ Price rules now catch spikes they used to miss

A price rule used to ask the exchange *"what is the price right now?"* once a minute. A spike that rose and fell between two checks was invisible to it — the rule simply never saw your target being hit.

Rules now ask *"what did the price reach since I last looked?"*, reading the highs and lows of every minute in that window. **An eight-second spike to your target now triggers the rule; before, it would have been missed entirely.** Checks are contiguous, so there are no gaps between them, and the log records both the peak that fired the rule and the price at the moment it ran.

Two things worth knowing:

- This catches the *event*, not the *price*. The rule fires on the next check and places a market order, so on a violent spike you'll trigger on the peak but fill near wherever the market has settled. If you need to sell *at* an exact number during a spike, a limit order resting on the exchange is the right tool — pair it with an "order fills" rule to handle the proceeds.
- Works on Kraken, Coinbase Advanced and Binance. Robinhood doesn't publish candle data, so its price rules continue to use single samples; the log labels which method was used.

The balancer deliberately still uses point-in-time snapshots — rebalancing your whole portfolio off a momentary wick would be a bug, not a feature.

### 🖱 Click a circle in the flow chart to edit its rule

The flow chart on Automations (and on Overview) is now interactive. Click any circle to open the rule behind it, instead of hunting for the matching row in the table.

- A circle with rules leaving it opens that rule; a destination circle — USDC, or a withdrawal wallet — opens the rules feeding into it.
- Where several rules meet at one circle, Cyrus asks which one you meant rather than guessing.
- Clicking a circle on the Overview chart takes you to Automations with that rule already open.
- Fully keyboard accessible, and balancer caps open the Balancer page rather than a dialog that can't edit them.

### 🔑 Robinhood key generator

Robinhood is the odd one out among the supported exchanges: it never gives you a secret key. You generate a keypair yourself, hand Robinhood the *public* half, and it returns an API key ID — which trips people up, because there's nothing to copy and paste from their site.

Select Robinhood in **Profile → Exchange Connections** and Cyrus now explains that, and offers an optional key generator to download. Run it and it prints the public key to register with Robinhood and the private key to paste into Cyrus.

It needs Python 3 and nothing else — no packages to install — and works with no internet connection at all. That's deliberate: generating your own keys offline means the private key exists nowhere until you choose to paste it. There's also a `--verify` mode that makes one signed request to Robinhood, so bad credentials fail with a clear explanation instead of a mysterious error inside the app.

### 🎨 Redesigned navigation

The sidebar is now grouped into **Portfolio**, **Automation** and **Account** instead of one flat list of eight links. The current page is marked with a tinted pill and an accent bar rather than being a shade brighter than its neighbours, icons are aligned to a common line, and the sidebar sits on its own surface so the app reads as a panel and a canvas rather than one flat sheet.

### 🐛 Bug Fixes

- **Table rows could stay blank until you moved the mouse over them.** The window was created without an opaque background colour, and a decorative animation ran permanently on a fixed overlay — between them, Chromium could skip redrawing a region after its contents changed, so rows only appeared once a hover forced a repaint. Both are fixed, and tables now explicitly invalidate themselves after their contents change.
- Text across the new pages was checked for contrast: several greys used for supporting text sat around 4:1 on the dark background and have been raised, and the red used for losses was too dim next to the green used for gains.
- **The Balancer's position rows were far too tall.** Its nine columns didn't fit the page width, so the "would trim now" sentence wrapped onto three lines and stretched every row with it. The Balancer and Holdings pages now use the full width of a wide window, and the amount to sell is shown to four significant figures rather than eight decimal places.
- **A cap label could be unreadable on a coin that had passed its cap** — the bar grows past its own handle, so the percentage sat on top of the amber fill. It's now outlined against whatever is behind it.
- **Exchange connections in your profile only showed their label.** Four accounts labelled "Main", "Trading", "Spot" and "Crypto" gave no clue which exchange each one was; every connection now shows its exchange alongside the label.

### 🔧 Under the hood

- Routes can now load more than one stylesheet, so a new page reuses the app's existing button, form and table styling instead of redefining it.
- The sidebar width is a single variable rather than a number repeated across five rules.

---

**Upgrading:** install over your existing version. Your database, settings, exchange connections, and automation rules are kept — they live in `%APPDATA%\Cyrus\` and are never touched by an install or uninstall. The new balancer settings are added to your existing database automatically on first launch.
