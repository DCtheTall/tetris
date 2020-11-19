import {BrowserWindow, app} from 'electron';

function createWindow() {
    const window = new BrowserWindow({width: 400, height: 400});
    window.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
