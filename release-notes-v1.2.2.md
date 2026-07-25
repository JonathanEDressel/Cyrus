## What's New in v1.2.2

A reliability release. Automations could stop running while Cyrus looked perfectly healthy — this fixes that, and makes it visible if it ever happens again.

### 🔴 Important: automations could silently stop

The background engine that checks your rules could freeze while the rest of the app carried on normally. Windows stayed responsive, rules saved fine, orders and balances loaded — but nothing was being evaluated, and there was no indication anywhere in the app. **If you have automations that seemed to stop firing for no reason, this was almost certainly why.**

Two causes, both fixed:

- **The engine could block on its own log output.** Once the app had been running a while (especially with an exchange error repeating), the engine could get stuck writing a message nobody was reading, and stop mid-cycle. Backend output now goes to a rotating log file at `%APPDATA%\Cyrus\logs\cyrus.log` instead.
- **A crashed or force-quit Cyrus left its backend running.** The leftover process kept holding the network port, so the next launch would quietly connect to the *old* one — potentially a version from weeks earlier. The backend now shuts down with the app, and any leftovers are cleared on startup.

### ✨ New Features

- **Live engine status on the Automations page** — a heartbeat showing when your rules were last checked. Green means running; amber means delayed or the last check errored; red means stopped, with a prompt to restart. Hover for the check count and the last error. You should never again have to guess whether automations are actually running.
- **Every skipped run is now logged** — the Log tab records *why* a rule didn't fire, not just when it did. Below the threshold, below the exchange's minimum withdrawal, cooling down, price under target, balances unavailable — each is written once with the reason, so "nothing happened" always has an explanation. Skips show in grey rather than error red, since a rule waiting on its threshold is working correctly.
- **Runs in the system tray** — closing the window now minimises to the tray so your automations keep running. The tray icon shows engine status at a glance and has an explicit **Quit** that stops everything. Also adds **Start Cyrus at login**, so scheduled rules survive a reboot.
- **Partners page** — a new page collecting the tools used alongside Cyrus, reachable from the sidebar and from Profile.

### 🐛 Bug Fixes

- The Automations page no longer stacks duplicate timers and keyboard handlers when you navigate back to it repeatedly.
- Exchange API calls now have an explicit timeout, so a hung connection can't stall the engine.
- Restarting a rule that hit its execution limit no longer appears to work and then silently re-pause without explanation — the log now records the auto-pause.

### 📄 Licensing

Cyrus now has a proper `LICENSE` file. It's **source-available under PolyForm Noncommercial 1.0.0** with two added conditions: modified versions must be shared under the same terms with full source, and you're responsible for what your configuration does with your funds. Free to use, study, modify, and republish for any noncommercial purpose — not to sell. The README previously claimed the ISC license, which was never accurate.

### 📚 Documentation

The README has been rewritten and corrected — the old one misstated the refresh interval, the database filename, the CORS policy, and several setup details. It now includes a troubleshooting table mapping each engine status to a fix.

---

**Upgrading:** install over your existing version. Your database, settings, exchange connections, and automation rules are kept — they live in `%APPDATA%\Cyrus\` and are never touched by an install or uninstall.
