import electron from 'electron';
import { app, BrowserWindow, Menu, powerSaveBlocker, ipcMain, dialog } from 'electron';
import settings from 'electron-settings';
import path from 'path';
import fs from 'fs';
import { SourceMapConsumer, RawSourceMap, NullableMappedPosition } from 'source-map';

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

// Source map cache for resolving TypeScript locations
const sourceMapCache = new Map<string, SourceMapConsumer>();

async function resolveSourceLocation(
  sourceId: string,
  line: number
): Promise<{ file: string; line: number } | null> {
  if (!sourceId) return null;

  // Convert file:// URL to path if present
  let jsPath = sourceId;
  if (sourceId.startsWith('file://')) {
    jsPath = sourceId.replace(/^file:\/\//, '');
  }

  // Only process .js files from our dist directory
  if (!jsPath.endsWith('.js') || !jsPath.includes('/dist/')) {
    return null;
  }

  // Ensure absolute path
  if (!path.isAbsolute(jsPath)) {
    return null;
  }

  const mapPath = jsPath + '.map';

  try {
    // Check cache first
    let consumer = sourceMapCache.get(mapPath);

    if (!consumer && fs.existsSync(mapPath)) {
      const mapContent = fs.readFileSync(mapPath, 'utf-8');
      const rawMap: RawSourceMap = JSON.parse(mapContent);
      consumer = await new SourceMapConsumer(rawMap);
      sourceMapCache.set(mapPath, consumer);
    }

    if (consumer) {
      // Try columns 0-100 to find a valid mapping (handles indentation)
      let pos: NullableMappedPosition = { source: null, line: null, column: null, name: null };
      for (let col = 0; col < 100 && !pos.source; col++) {
        pos = consumer.originalPositionFor({ line, column: col });
      }
      if (pos.source && pos.line) {
        // Resolve to absolute path from sourceRoot
        const distDir = path.dirname(jsPath);
        const srcFile = path.resolve(distDir, pos.source);
        return { file: srcFile, line: pos.line };
      }
    }
  } catch {
    // Silently ignore source map errors
  }

  return null;
}

const defaultWidth = 1000;
// Narrowest normal-view window, in points. The renderer keeps this at (CSS floor x zoom) so zoom never forces a horizontal scrollbar.
let normalMinWidth = 540;
const defaultHeight = 730;
const projectRoot = path.join(__dirname, '../..');
const iconPath = path.join(projectRoot, 'res/zoner.png');

let win: BrowserWindow | null;
// full-size bounds to restore when leaving mini view; non-null while in mini view
let fullBounds: electron.Rectangle | null = null;

function createWindow(): void {
  const rect = storedWindowPos();
  const miniSize = settings.get('miniWindowSize') as { width: number; height: number } | undefined;
  const miniPos = onScreenPos(settings.get('miniWindowPos') as WindowRect | undefined);
  const startMini = settings.get('miniMode') === true && !!miniSize;
  if (startMini) {
    // full-size bounds are kept aside and restored when leaving mini view
    const wa = electron.screen.getPrimaryDisplay().workArea;
    fullBounds = rect ?? {
      x: Math.round(wa.x + (wa.width - defaultWidth) / 2),
      y: Math.round(wa.y + (wa.height - defaultHeight) / 2),
      width: defaultWidth,
      height: defaultHeight
    };
  }
  win = new BrowserWindow({
    x: startMini ? miniPos?.x : rect ? rect.x : undefined,
    y: startMini ? miniPos?.y : rect ? rect.y : undefined,
    title: 'midi-zoner',
    useContentSize: startMini,
    width: startMini ? miniSize!.width : rect ? rect.width : defaultWidth,
    height: startMini ? miniSize!.height : rect ? rect.height : defaultHeight,
    minWidth: startMini ? 1 : normalMinWidth,
    minHeight: startMini ? 1 : 200,
    alwaysOnTop: startMini,
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

  // Forward renderer console messages to main process terminal
  win.webContents.on('console-message', async (e) => {
    const { level, message, lineNumber, sourceId } = e;
    const original = await resolveSourceLocation(sourceId, lineNumber);
    const source = original
      ? `${path.relative(projectRoot, original.file)}:${original.line}`
      : sourceId
        ? `${sourceId}:${lineNumber}`
        : '';
    console.log(`[${level.toUpperCase()}] ${message}${source ? ` (${source})` : ''}`);
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isMac = process.platform === 'darwin';
    if (isMac ? (input.meta && input.alt && input.code === 'KeyI') : (input.control && input.shift && input.code === 'KeyI')) {
      event.preventDefault();
      win!.webContents.toggleDevTools();
    }
  });
  win.on('close', () => {
    saveWindowPos(win!);
  });
  win.on('closed', () => {
    win = null;
  });
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' as const }]));
  } else {
    Menu.setApplicationMenu(null);
  }
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
  ipcMain.handle('set-view-mode', (event, mini: boolean, width: number, height: number) => {
    if (!win) return;
    if (mini) {
      if (!fullBounds) {
        fullBounds = win.getBounds();
        const miniPos = onScreenPos(settings.get('miniWindowPos') as WindowRect | undefined);
        win.setMinimumSize(1, 1);
        if (miniPos) win.setPosition(miniPos.x, miniPos.y);
      }
      win.setAlwaysOnTop(true, 'floating');
      win.setContentSize(Math.round(width), Math.round(height));
      settings.set('miniMode', true);
      settings.set('miniWindowSize', { width: Math.round(width), height: Math.round(height) });
    } else if (fullBounds) {
      settings.set('miniMode', false);
      saveMiniPos(win);
      const restore = fullBounds;
      fullBounds = null;
      win.setAlwaysOnTop(false);
      win.setMinimumSize(normalMinWidth, 200);
      win.setBounds(restore);
    }
  });
  ipcMain.handle('set-min-width', (event, width: number) => {
    normalMinWidth = Math.max(320, Math.round(width));
    // in mini view the window may be tiny; the new minimum applies when leaving it
    if (win && !fullBounds) {
      win.setMinimumSize(normalMinWidth, 200);
      // the OS does not grow an existing window to a new minimum (e.g. after zooming in), so do it here
      const [currentWidth, currentHeight] = win.getSize();
      if (currentWidth < normalMinWidth) win.setSize(normalMinWidth, currentHeight);
    }
    return win ? win.getMinimumSize() : [normalMinWidth, 200];
  });
  ipcMain.handle('open-about', () => openAboutWindow());
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
    if (fullBounds) saveMiniPos(win);
    settings.set('windowPos', fullBounds ?? win.getBounds());
  }
}

function saveMiniPos(win: BrowserWindow): void {
  const { x, y } = win.getBounds();
  settings.set('miniWindowPos', { x, y });
}

function storedWindowPos(): WindowRect | undefined {
  const rect = settings.get('windowPos') as WindowRect | undefined;
  if (rect) {
    if (rect.width < defaultWidth) rect.width = defaultWidth;
    if (rect.height < defaultHeight) rect.height = defaultHeight;
  }
  return onScreenPos(rect);
}

/** Returns the rect only if its top-left corner is within some display. */
function onScreenPos<T extends { x: number; y: number }>(rect: T | undefined): T | undefined {
  if (!rect) return rect;
  const max_thresh = 100;
  const isVisible = electron.screen.getAllDisplays().some((display) => {
    const bounds = display.bounds;
    return (
      rect.x >= bounds.x &&
      rect.x < bounds.x + bounds.width - max_thresh &&
      rect.y >= bounds.y &&
      rect.y < bounds.y + bounds.height - max_thresh
    );
  });
  return isVisible ? rect : undefined;
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
