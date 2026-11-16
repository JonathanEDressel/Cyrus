## New: Automations flow map

The circle chart on the Automations page is now a left-to-right map of where your money goes. The coins being sent are on the left, a chip for each rule sits in the middle (showing its trigger and amount, dashed when paused), and where the money ends up is on the right. Each rule has its own line, and a rule that loops back (USDT → BTC → USDT) is drawn as a return line under the map.

Click a chip to highlight that rule's path and read it in plain English below, with **Edit** and **Pause/Resume** right there. On the Overview, **Open in Automations** takes you straight to it.

## New: optional anonymous usage stats

After you sign in, Cyrus asks once whether you'd like to share anonymous usage stats. They're **off unless you say yes**. They help count how many copies of Cyrus are in use, which helps decide what to work on next.

If you opt in, Cyrus sends a small check-in when it starts, when you sign in or out, every five minutes while it's running, and when it quits. Each one contains only:

- a random install ID, created when you opt in and not linked to your account
- the Cyrus version, and Windows or macOS
- whether the window is open or Cyrus is running in the tray
- whether someone is signed in
- your country, which the server works out from your connection (only the country is kept, never your city or IP address)

It never includes your username, email, IP address, balances, exchanges, API keys, orders or rules. You can change your answer any time in **Profile → Account**. Turning it off deletes what was sent, and records are deleted automatically after 90 days anyway. The **Privacy** page has the details, plus a complete list of every service Cyrus connects to.

**Updating from 1.3.0 or later on Windows:** use **Update now** in the window Cyrus shows, or the **Update** button in the top bar.

**Upgrading from an earlier version:** install over your existing version. Your database, settings, exchange connections and automation rules are kept.
