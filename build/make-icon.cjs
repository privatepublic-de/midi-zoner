'use strict';
// Renders build/icon.svg with offscreen Electron to the app's icons: res/zoner.png (window, About), assets/zoner.png
// (Windows build) and assets/zoner.icns (macOS, via sips and iconutil). Run: npm run icon
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 300));
  const png = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' }).toPNG();
  for (const out of ['res/zoner.png', 'assets/zoner.png']) fs.writeFileSync(path.join(root, out), png);
  let wrote = 'res/zoner.png, assets/zoner.png';
  if (process.platform === 'darwin') {
    const src = path.join(root, 'assets/zoner.png');
    const set = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'midi-zoner-icon-')), 'icon.iconset');
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      execFileSync('sips', ['-z', String(s), String(s), src, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
      execFileSync('sips', ['-z', String(s * 2), String(s * 2), src, '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'assets/zoner.icns')]);
    wrote += ', assets/zoner.icns';
  }
  console.log('wrote ' + wrote);
  app.quit();
});
