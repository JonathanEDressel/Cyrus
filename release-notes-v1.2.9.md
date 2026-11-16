## New: Gemini (Beta)

You can now connect a **Gemini** account. Go to **Profile → Exchange Connections**, choose **Gemini (Beta)** and paste in an API key and secret.

Create the key at **exchange.gemini.com → Settings → API** with the **Trader** role. Trader is Gemini's default, and it covers balances, orders and trade history. An **Auditor** key can only read, so convert actions won't work with it. Keys from Gemini's sandbox also work: tick **Sandbox** when you add the connection.

Everything Cyrus does on Binance also works on Gemini:

- Balances, portfolio value and charts, open orders, and cancelling orders
- Limit orders and staggered ladders, including post-only (maker) orders
- Automations triggered by an order filling, a balance threshold, a price target or an allocation cap, with a convert action
- Transfer history, and trade history for the Taxes page
- GUSD, Gemini's dollar, counts as cash in totals and tax calculations

**How converts work on Gemini.** Gemini's API doesn't accept market orders. When an automation converts on Gemini, Cyrus places a limit order priced up to 2% past the best price that fills immediately and cancels whatever doesn't fill. The order never fills more than 2% beyond the best price at the moment it's placed. If only part of it fills, the automation log says *partially filled*. If none of it fills, the run is logged as an error and nothing is traded.

**Not available on Gemini yet:** withdraw actions and the withdrawal address book. As on Coinbase and Binance, automations can convert but can't send funds out.

**Taxes page:** Gemini reports trades one market at a time, so Cyrus checks the markets for coins you hold, have moved, or have traded before. A coin you bought and sold entirely between syncs, without ever transferring it, can be missed.

**Upgrading:** install over your existing version. Your database, settings, exchange connections and automation rules are kept.
