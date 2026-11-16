## New: Cyrus for Mac

Cyrus now runs on macOS 12 or later, on both Apple Silicon and Intel Macs. Pick the download that matches your Mac:

- **Apple Silicon (M1 and later):** `Cyrus-1.2.8-arm64.dmg`
- **Intel:** `Cyrus-1.2.8-x64.dmg`

Not sure which you have? Open  → **About This Mac**. "Chip: Apple M…" means Apple Silicon; "Processor: Intel" means Intel.

### Installing on a Mac

1. Open the `.dmg` and drag **Cyrus** into **Applications**.
2. Open Cyrus. macOS stops it the first time, because it isn't signed with an Apple Developer ID yet. Click **Done**.
3. Open **System Settings → Privacy & Security**, scroll down to the message about Cyrus and click **Open Anyway**, then confirm. You only have to do this once.

If you prefer Terminal, this does the same as step 3:

```
xattr -dr com.apple.quarantine /Applications/Cyrus.app
```

Everything works as on Windows. A few things are Mac-specific:

- **Closing the window keeps your automations running.** Cyrus stays in the menu bar (the `C_` icon at the top of the screen). Choose **Quit Cyrus** there, or press ⌘Q, to stop it.
- **Shortcuts use ⌘**: ⌘K opens the assistant, and copy and paste work as usual.
- **Your data stays on your Mac**, in `~/Library/Application Support/Cyrus`.

## New: customisable Overview

Click **Customize** at the top of the Overview to arrange it your way:

- **Move** widgets by dragging the grip, or with the ← → buttons.
- **Resize** by dragging a widget's bottom-right corner. Widths snap to a 12-column grid. Heights either fit the content or stay fixed, with the content scrolling inside.
- **Add** widgets from a list, and remove any you don't use.
- **Reset** returns to the original layout.

Your layout is saved to your account as you go.

Five new widgets:

- **Top movers:** your holdings that rose or fell most in the last 24 hours.
- **Accounts:** the value of each connected exchange account, its share of your total and its open orders.
- **Recent transfers:** your latest deposits and withdrawals.
- **Quick actions:** one-click shortcuts to limit orders, automations, caps, transfers, taxes and the assistant.
- **Notes:** a scratchpad for targets and reminders, saved with your layout.

## Also

- Updated to a current Electron (the framework Cyrus runs on), with the latest security fixes.
- The Privacy page now gives the correct database location on both Windows and macOS.

**Upgrading on Windows:** install over your existing version. Your database, settings, exchange connections and automation rules are kept. The Overview starts with the default layout until you customise it.
