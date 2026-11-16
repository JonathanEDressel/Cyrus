## New: tutorials inside Cyrus

Every page now has a **Tutorial** button in its header. It opens a narrated walkthrough of that page in a panel on the right, with chapters you can jump between and captions. On a normal-sized window the page moves over to make room, so you can follow along while it plays. Profile has two: **Getting Started** and **The AI Assistant**.

The videos are part of the app, so they play offline. They're recorded in demo mode, so the balances and orders in them are sample data. The same videos are on the website.

## New: update notifications

From this version on, Cyrus tells you when a newer version is out. A window shows what's new, and an **Update** button stays in the top bar until you install it.

- **Windows:** **Update now** downloads the update in the background while you keep working. **Restart now** installs it and reopens Cyrus. Automations pause for a few seconds. Choose **Later** and it installs the next time you quit.
- **Mac:** **Download for Mac** opens the right .dmg for your Mac in your browser. Drag Cyrus into Applications and choose **Replace**. Installing in place on the Mac needs Apple's developer signing, which Cyrus doesn't have yet.

The check is an anonymous request to GitHub for the latest release. It sends nothing about you or your accounts.

## Fixes

- **Holdings:** the column headers no longer let scrolled rows show through.
- **Profile:** the **Use Sandbox / Testnet** option for Gemini is a plain checkbox again. Before, it was an oddly boxed label that became unreadable once ticked.
- **Limit Orders:** the hint now says ladder progress shows in the top bar, which is where it is.

**Upgrading:** install over your existing version. Your database, settings, exchange connections and automation rules are kept. This is the last version you need to download by hand. On Windows, later versions install from inside Cyrus.

**The Windows installer is now `Cyrus-Setup-1.3.0.exe`** (with dashes rather than spaces), and it's larger than before because it includes the tutorial videos.
