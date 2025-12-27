import electron from 'electron';
import { app, BrowserWindow, Menu, powerSaveBlocker, ipcMain, dialog, shell } from 'electron';
import settings from 'electron-settings';
import path from 'path';
import fs from 'fs';

interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SaveResult {
  canceled: boolean;
  warning: boolean;
  message: string | null;
}

powerSaveBlocker.start('prevent-app-suspension');

const defaultWidth = 1000;
const defaultHeight = 730;
const iconPath = path.join(__dirname, '../../res/zoner.png');

let win: BrowserWindow | null;

function createWindow(): void {
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
    win!.show();
  });
  win.loadFile(path.join(__dirname, '../../index.html'));
  win.on('close', () => {
    saveWindowPos(win!);
  });
  win.on('closed', () => {
    win = null;
  });
  createApplicationMenu();
  ipcMain.handle('open-save', async (event, ...args): Promise<SaveResult> => {
    let eventResult: SaveResult = {
      canceled: true,
      warning: false,
      message: null
    };
    await dialog
      .showSaveDialog(win!, {
        title: 'Save current scene',
        message: 'Save current scene',
        filters: [{ name: 'midi-zoner Scene', extensions: ['json'] }],
        properties: ['createDirectory']
      })
      .then((result) => {
        eventResult.canceled = result.canceled;
        if (!result.canceled) {
          try {
            fs.writeFileSync(result.filePath!, args[0], 'utf-8');
            eventResult.message = `Saved scene as ${result.filePath}`;
          } catch (e) {
            console.log(e);
            eventResult.message = 'Failed to save the file!';
            eventResult.warning = true;
          }
        }
      });
    return eventResult;
  });
  ipcMain.handle('open-load', async (event): Promise<string | undefined> => {
    let content: string | undefined;
    await dialog
      .showOpenDialog(win!, {
        title: 'Add zones',
        message: 'Add zones from file',
        buttonLabel: 'Add zones from file',
        filters: [{ name: 'midi-zoner Scene', extensions: ['json'] }]
      })
      .then((result) => {
        if (!result.canceled) {
          content = fs.readFileSync(result.filePaths[0], 'utf-8');
        }
      });
    return content;
  });
  ipcMain.handle('open-confirm', async (event, ...args): Promise<boolean> => {
    let confirmed = false;
    await dialog
      .showMessageBox(win!, {
        type: 'none',
        title: args[0] as string,
        message: args[1] as string,
        buttons: ['OK', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      })
      .then((result) => {
        confirmed = result.response === 0;
      });
    return confirmed;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

function saveWindowPos(win: BrowserWindow): void {
  if (!win.isMinimized()) {
    let rect = win.getBounds();
    settings.set('windowPos', rect);
  }
}

function storedWindowPos(): WindowRect | undefined {
  let rect = settings.get('windowPos') as WindowRect | undefined;
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
        rect!.x >= bounds.x &&
        rect!.x < bounds.x + bounds.width - max_thresh &&
        rect!.y >= bounds.y &&
        rect!.y < bounds.y + bounds.height - max_thresh
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

function createApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    // { role: 'appMenu' }
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    // { role: 'fileMenu' }
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }]
    },
    // { role: 'viewMenu' }
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    },
    // { role: 'windowMenu' }
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Documentation',
          click: async () => {
            await shell.openExternal(
              'https://github.com/privatepublic-de/midi-zoner/wiki'
            );
          }
        },
        { type: 'separator' as const },
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

function openAboutWindow(): void {
  let aboutWin: BrowserWindow | null = new BrowserWindow({
    title: 'About midi-zoner',
    width: 400,
    height: 450,
    minWidth: 400,
    minHeight: 450,
    backgroundColor: '#000000',
    icon: iconPath,
    show: false,
    parent: win!,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  aboutWin.once('ready-to-show', () => {
    aboutWin!.show();
  });
  aboutWin.loadFile(path.join(__dirname, '../../res/about.html'));
  aboutWin.on('closed', () => {
    aboutWin = null;
  });
  aboutWin.removeMenu();
}
