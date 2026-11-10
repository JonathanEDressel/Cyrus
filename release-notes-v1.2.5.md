## New: Taxes

A **Taxes** page under Portfolio that works out your realized gains and losses from the trades and transfers on your connected exchanges.

- **Trade history sync.** One **Sync history** button pulls every fill from each connected exchange, then brings transfers up to date. Like Transfers, it runs in bounded slices behind a progress bar, saves as it goes, and resumes where it stopped if interrupted.
  - Kraken and Coinbase are read in date windows.
  - Binance has no "all my trades" call, so it is read market by market, using every coin Cyrus has seen you hold or move.
  - Robinhood is read from filled orders.
- **FIFO or HIFO.** Switch between first-in-first-out and highest-in-first-out and every figure updates. HIFO usually gives the smallest gain. Your choice is remembered.
- **Per-year summary**: proceeds, cost basis, and short- and long-term gain, plus a table with one row for each lot sold.
- **Coins are tracked per exchange account.** When you move coins between two of your own connected exchanges, they keep their original cost and purchase date, and the network fee is added to their cost.
- **Trades priced in another coin are valued in USD.** For example, ETH sold for BTC is valued from the hourly price at the time of the trade.
- **Two exports:**
  - **Form 8949 CSV**: one row per sale for the selected year, in the columns of IRS Form 8949.
  - **Koinly CSV**: your full trade and transfer history in Koinly's universal import format.

**Nothing is guessed.** When Cyrus can't account for a coin, the row is flagged *missing cost basis* rather than filled with an assumed figure. This happens with coins deposited from a wallet or platform Cyrus can't see, or with sales beyond the history an exchange returns.

### Filling in what's missing

Every flagged row has a **Fix** button, and the gains recalculate as soon as you save:

- **Coins deposited from elsewhere:** enter what you originally paid and when you bought them. The purchase date decides short- vs long-term, so coins bought years before you deposited them come out long-term.
- **Sold more than Cyrus has records for:** add the purchase those coins came from.
- **A trade that couldn't be valued in USD:** **Add price** lets you enter what the other coin was worth at the time, and shows the resulting proceeds as you type.

Also on the page:

- **Needs info** narrows the table to the rows still missing something. Its count drops as you fix them.
- **Add a purchase** records a buy Cyrus never saw, such as one made before an exchange's history starts or on another platform.
- **Entered by hand** lists everything you've typed in, and any entry can be removed. Rows that use a hand-entered cost are tagged *manual*, and the Form 8949 export notes "Cost basis entered manually" on them.
- Re-syncing never overwrites anything you entered.

**Trade history needs the same read permission on your API key as transfer history.** If a key is refused, the page names the missing permission rather than showing an empty table.

## Limit Orders: Export CSV

An **Export CSV** button on the Limit Orders page saves every resting buy and sell, after your current exchange and search filters.

- One row per order, with exchange, pair, side, limit price, amount, filled, remaining, value if filled, and when it was opened.
- **Sells show their cost basis and estimated gain if filled**, worked out from the Taxes page using your chosen method. Two sells of the same coin can't both count the same cheap purchase, so the gains add up correctly.
- **A TOTAL row** at the end gives the combined estimated gain if every order fills. If some orders can't be included, a note row says how many and why.

The gain columns cover sells on USD and dollar-stablecoin pairs. If trade history hasn't been synced yet, they read *cost unknown* and the rest of the export still works.

## Worth knowing

- **This is not tax advice.** Review the export with your tax software or an accountant before filing.
- **USD and dollar stablecoins are treated as cash**, so moving between them doesn't count as a sale.
- **The Koinly export carries trades and transfers, but not costs you entered by hand.** Koinly works out its own gains, so enter those in Koinly too.
- **Binance trades can be missed on a coin you never held a balance of or moved**, because Cyrus has to know a market exists before it can ask for its trades.
- **In demo mode, the Taxes page shows sample data.** Exports and hand-entered costs are disabled there.
