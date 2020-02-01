const electron = require("electron");
const { app, BrowserWindow } = electron;
const settings = require("electron-settings");

const minWidth = 950;
const minHeight = 720;

let win

function createWindow () {
  const rect = storedWindowPos();
  win = new BrowserWindow({
    x: rect?rect.x:undefined,
    y: rect?rect.y:undefined,
    width: rect?rect.width:minWidth,
    height: rect?rect.height:minHeight,
    minWidth: minWidth,
    minHeight: minHeight,
    autoHideMenuBar: true,
    icon: __dirname + '/res/zoner.png',
    webPreferences: {
      nodeIntegration: true
    }
  })
  win.loadFile('index.html')
  // win.webContents.openDevTools()

  win.on('close', ()=> {
    saveWindowPos(win);
  });

  win.on('closed', () => {
    win = null
  })
}

app.on('ready', createWindow)

app.on('window-all-closed', () => {
    app.quit()  
})

function saveWindowPos(win) {
  if (!win.isMinimized()) {
    let rect = win.getContentBounds();
    settings.set('windowPos', rect);
  }
}

function storedWindowPos() {
  let rect = settings.get('windowPos');
  if (rect) {
    // check if stored window pos is within screen
    if (rect.width < minWidth) rect.width = minWidth;
    if (rect.height < minHeight) rect.height = minHeight;
    let displays = electron.screen.getAllDisplays();
    let isVisible = false;
    const max_thresh = 100;
    displays.forEach(display => {
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
