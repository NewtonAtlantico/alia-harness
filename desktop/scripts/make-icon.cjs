/**
 * Draws the stand-in application icon (build/icon.png, 512x512): "alia" in white on a rounded tile in the brand blue. It runs in
 * Electron because a hidden window has a canvas, so no image library is needed. Run from desktop/: `npx electron scripts/make-icon.cjs`.
 * The logo files we have are small, opaque and on their own background, so they do not make a clean icon. Replace build/icon.png
 * with the icon from the design owner (section 9 of the backlog) and the installer and the executable pick it up.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const out = path.join(__dirname, '..', 'build', 'icon.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600 });
  await win.loadURL('about:blank');
  const data = await win.webContents.executeJavaScript(`(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const x = c.getContext('2d');
    x.beginPath();
    x.roundRect(16, 16, 480, 480, 104);
    const g = x.createLinearGradient(0, 16, 0, 496);
    g.addColorStop(0, '#3a6fd0');
    g.addColorStop(1, '#26409a');
    x.fillStyle = g;
    x.fill();
    x.fillStyle = '#ffffff';
    x.font = '700 230px "Segoe UI", Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'alphabetic';
    x.fillText('alia', 256, 318);
    return c.toDataURL('image/png');
  })()`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
  console.log('wrote', out);
  app.quit();
});
