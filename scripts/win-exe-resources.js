// Stamp Cyrus's icon and version details into the packaged Cyrus.exe.
//
// electron-builder normally does this itself, but only when
// win.signAndEditExecutable is on — and that makes it unpack its winCodeSign
// toolkit, whose archive contains macOS symlinks that Windows refuses to create
// without admin rights or Developer Mode. With the option off (as it is here),
// the exe kept Electron's default icon and "Electron" in its file details, so
// the Desktop/Start Menu shortcuts and the taskbar showed the Electron logo.
// rcedit is the same tool electron-builder would have run.
const path = require('path');
const fs = require('fs');

exports.default = async function winExeResources(context) {
  const rceditModule = require('rcedit');
  const rcedit = rceditModule.rcedit || rceditModule.default || rceditModule;
  const { appInfo } = context.packager;
  const exe = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const icon = path.join(context.packager.projectDir, 'src', 'assets', 'icon.ico');
  if (!fs.existsSync(exe)) throw new Error(`[win-exe] ${exe} not found`);
  if (!fs.existsSync(icon)) throw new Error(`[win-exe] ${icon} not found`);

  // Windows wants four-part numeric versions.
  const numeric = appInfo.version.split('-')[0].split('.').concat(['0', '0', '0', '0']).slice(0, 4).join('.');
  console.log(`[win-exe] Setting icon and version ${appInfo.version} on ${path.basename(exe)}`);
  await rcedit(exe, {
    icon,
    'file-version': numeric,
    'product-version': numeric,
    'version-string': {
      FileDescription: appInfo.productName,
      ProductName: appInfo.productName,
      InternalName: appInfo.productFilename,
      OriginalFilename: `${appInfo.productFilename}.exe`,
      CompanyName: appInfo.companyName || appInfo.productName,
      LegalCopyright: appInfo.copyright || `Copyright © ${new Date().getFullYear()} ${appInfo.productName}`,
    },
  });
};
