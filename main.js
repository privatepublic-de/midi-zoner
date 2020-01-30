const { app, BrowserWindow } = require('electron')

let win

function createWindow () {

  win = new BrowserWindow({
    width: 950,
    height: 700,
    icon: __dirname + '/res/zoner.png',
    webPreferences: {
      nodeIntegration: true
    }
  })

  win.loadFile('index.html')
  // win.webContents.openDevTools()

  win.on('closed', () => {
    win = null
  })
}

app.on('ready', createWindow)

app.on('window-all-closed', () => {
    app.quit()  
})
