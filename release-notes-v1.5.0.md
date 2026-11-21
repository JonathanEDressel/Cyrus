## Your data is now encrypted

The whole Cyrus database is now encrypted (AES-256). It holds your account, rules, balances history, trades and exchange keys. The key is unique to your computer and locked by Windows or macOS to your user account, so a copy of the database file can't be read anywhere else. Your exchange API keys stay encrypted inside it as well.

**Important security fix.** Until now every copy of Cyrus used the same built-in key to protect stored exchange API keys, so anyone who got hold of your database file could have decrypted them. Each install now has its own key, and your existing data is converted and re-encrypted automatically the first time 1.5.0 starts.

- **You'll be asked to sign in once** after updating. Your rules, history and exchange connections are all kept.
- **On a Mac**, macOS may ask whether Cyrus can use its keychain item. Click **Always Allow**.
- Copying Cyrus's data folder to another computer no longer carries your data with it. Set Cyrus up fresh on the new machine and reconnect your exchanges.

## New exchanges (beta)

- **OKX**: needs the passphrase you chose when creating the API key.
- **KuCoin**: needs the key's passphrase. Only coins in your Trading account are visible. Trade and transfer history aren't imported yet.
- **Crypto.com Exchange**: use keys from the Crypto.com *Exchange*, not the Crypto.com App.
- **Gate.io**

All four support balances, open and limit orders, price, balance and order-fill automations, converts, and the portfolio balancer.

**Coinbase Advanced, Binance and Robinhood are out of beta.** This release also fixes converts on Coinbase that spend dollars (or another quote currency) to buy a coin, which previously failed.

## Charts

- **Open Orders** now uses the same left-to-right flow map as Automations. Click an order to see it in plain English.
- **Zoom and drag** on both flow maps. Use the − / + buttons, or Ctrl/⌘ + scroll. Each chart remembers its zoom, and the zoom bar stays in view as you scroll.
- **Live Data** charts can show any Kraken pair (XRP/CAD, ETH/EUR, SOL/BTC…), priced in that pair's currency. Under each chart are the range's high and low, 24-hour volume and market cap.

## Also

- The price ticker under the top bar now scrolls through **all** your holdings.
- The **Supported Automations by Exchange** table on Automations has a cleaner layout and remembers whether you hid it.
- Windows notifications now say **Cyrus** instead of "Electron".
- Updated components, including security fixes.

**Updating on Windows:** use **Update now** in the window Cyrus shows, or the **Update** button in the top bar.

**Upgrading from an earlier version:** install over your existing version. Your database, settings, exchange connections and automation rules are kept and encrypted on first start.
