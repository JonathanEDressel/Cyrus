// electron-builder afterPack hook: per-platform finishing on the packaged app,
// before the installer (.exe / .dmg) is built around it.
//   Windows → win-exe-resources.js (icon + version details on Cyrus.exe)
//   macOS   → mac-adhoc-sign.js   (ad-hoc code signature)
exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    return require('./win-exe-resources').default(context);
  }
  if (context.electronPlatformName === 'darwin') {
    return require('./mac-adhoc-sign').default(context);
  }
};
