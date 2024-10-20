const electron = require('electron');
const { app, BrowserWindow, Menu, powerSaveBlocker, ipcMain, dialog } =
  electron;
const settings = require('electron-settings');
const path = require('node:path');
const fs = require('fs');

powerSaveBlocker.start('prevent-app-suspension');

const defaultWidth = 1000;
const defaultHeight = 730;
const iconPath = __dirname + '/res/zoner.png';

let win;

function createWindow() {
  const rect = storedWindowPos();
  win = new BrowserWindow({
    x: rect ? rect.x : undefined,
    y: rect ? rect.y : undefined,
    title: 'midi-zoner',
    width: rect ? rect.width : defaultWidth,
    height: rect ? rect.height : defaultHeight,
    minWidth: defaultWidth,
    minHeight: 200,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    },
    acceptFirstMouse: true,
    show: false
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  win.loadFile('index.html');
  win.on('close', () => {
    saveWindowPos(win);
  });
  win.on('closed', () => {
    win = null;
  });
  createApplicationMenu();
  ipcMain.handle('open-save', (event, ...args) => {
    dialog
      .showSaveDialog(win, {
        title: 'Save current scene',
        message: 'Save current scene',
        filters: [{ name: 'midi-zoner Scene', extensions: ['json'] }],
        properties: ['createDirectory']
      })
      .then((result) => {
        if (!result.canceled) {
          console.log(`filePath: ${result.filePath}, json: ${args[0]}`);
          try {
            fs.writeFileSync(result.filePath, args[0], 'utf-8');
          } catch (e) {
            console.log('Failed to save the file !');
          }
        }
      });
  });
  ipcMain.handle('open-load', async (event) => {
    let content;
    await dialog
      .showOpenDialog(win, {
        title: 'Add zones',
        message: 'Add zones from file',
        buttonLabel: 'Add zones from file',
        filters: [{ name: 'midi-zoner Scene', extensions: ['json'] }]
      })
      .then((result) => {
        if (!result.canceled) {
          console.log(`OPEN: ${result.filePaths[0]}`);
          content = fs.readFileSync(result.filePaths[0], 'utf-8');
        }
      });
    return content;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

function saveWindowPos(win) {
  if (!win.isMinimized()) {
    let rect = win.getBounds();
    settings.set('windowPos', rect);
  }
}

function storedWindowPos() {
  let rect = settings.get('windowPos');
  if (rect) {
    // check if stored window pos is within screen
    if (rect.width < defaultWidth) rect.width = defaultWidth;
    if (rect.height < defaultHeight) rect.height = defaultHeight;
    let displays = electron.screen.getAllDisplays();
    let isVisible = false;
    const max_thresh = 100;
    displays.forEach((display) => {
      let bounds = display.bounds;
      if (
        rect.x >= bounds.x &&
        rect.x < bounds.x + bounds.width - max_thresh &&
        rect.y >= bounds.y &&
        rect.y < bounds.y + bounds.height - max_thresh
      ) {
        isVisible = true;
      }
    });
    if (isVisible) {
      return rect;
    } else {
      return undefined;
    }
  }
  return rect;
}

function createApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // { role: 'appMenu' }
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideothers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),
    // { role: 'fileMenu' }
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    // { role: 'viewMenu' }
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggledevtools' },
        { type: 'separator' },
        { role: 'resetzoom' },
        { role: 'zoomin' },
        { role: 'zoomout' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // { role: 'windowMenu' }
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front' }]
          : [{ role: 'close' }])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Documentation',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal(
              'https://github.com/privatepublic-de/midi-zoner/wiki'
            );
          }
        },
        { type: 'separator' },
        {
          label: 'About midi-zoner',
          click: async () => {
            openAboutWindow();
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function openAboutWindow() {
  let aboutWin = new BrowserWindow({
    title: 'About midi-zoner',
    width: 400,
    height: 450,
    minWidth: 400,
    minHeight: 450,
    backgroundColor: '#000000',
    icon: iconPath,
    show: false,
    parent: win,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  aboutWin.once('ready-to-show', () => {
    aboutWin.show();
  });
  aboutWin.loadFile('res/about.html');
  aboutWin.on('closed', () => {
    aboutWin = null;
  });
  aboutWin.removeMenu();
}
