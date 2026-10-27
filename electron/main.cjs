const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('node:path');
let bridge, win, closing = false;
if (!app.requestSingleInstanceLock())
    app.quit();
else {
    app.on('second-instance', () => { if (win) {
        if (win.isMinimized())
            win.restore();
        win.focus();
    } });
    app.whenReady().then(async () => {
        try {
            const { createServer } = await import('../server/index.mjs');
            bridge = await createServer({ dataDir: path.join(app.getPath('userData'), 'data'), resourcesPath: process.resourcesPath, native: {
                    pickDirectory: async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '选择项目文件夹' }); return r.canceled ? null : r.filePaths[0]; },
                    openDirectory: async (dir) => { const error = await shell.openPath(dir); if (error)
                        throw new Error(error); }
                }, onShutdown: () => app.quit() });
            win = new BrowserWindow({ width: 1440, height: 960, minWidth: 940, minHeight: 660, title: 'AstroGate Codex', frame: false, backgroundColor: '#edf3f7', show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
            Menu.setApplicationMenu(null);
            function valid(event) { return !!win && event.sender === win.webContents && new URL(event.senderFrame.url).origin === bridge.baseUrl; }
            ipcMain.handle('window:action', (event, action) => { if (!valid(event))
                return; if (action === 'minimize')
                win.minimize();
            else if (action === 'maximize')
                win.isMaximized() ? win.unmaximize() : win.maximize();
            else if (action === 'close')
                win.close(); });
            ipcMain.handle('clipboard:write', (event, value) => { if (!valid(event))
                return; if (typeof value !== 'string' || value.length > 8 * 1024 * 1024)
                throw new Error('复制内容过大或无效'); clipboard.writeText(value); return true; });
            ipcMain.handle('external:open', async (event, url) => { if (!valid(event))
                return; const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol))
                throw new Error('只允许网页地址'); const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '打开浏览器'], defaultId: 0, cancelId: 0, message: '打开外部网站？', detail: u.origin }); if (r.response === 1)
                await shell.openExternal(u.href); });
            win.webContents.setWindowOpenHandler(({ url }) => { try {
                const u = new URL(url);
                if (['https:', 'http:'].includes(u.protocol))
                    void dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '打开'], defaultId: 0, message: '打开外部网站？', detail: u.origin }).then(r => { if (r.response === 1)
                        shell.openExternal(u.href); });
            }
            catch { } return { action: 'deny' }; });
            win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== bridge.baseUrl)
                event.preventDefault(); });
            win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
            win.on('close', async (event) => {
                if (closing)
                    return;
                event.preventDefault();
                if (bridge.service.running) {
                    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['继续任务', '停止并退出'], defaultId: 0, cancelId: 0, message: '任务仍在执行', detail: '退出将停止本应用启动的 Codex 内核。未完成任务不会自动重发。' });
                    if (r.response !== 1)
                        return;
                }
                closing = true;
                await bridge.close();
                win.destroy();
                app.quit();
            });
            await win.loadURL(bridge.url);
            win.show();
        }
        catch (e) {
            dialog.showErrorBox('AstroGate 启动失败', e.message);
            app.quit();
        }
    });
    app.on('before-quit', event => { if (bridge && !closing) {
        event.preventDefault();
        if (win)
            win.close();
        else {
            closing = true;
            bridge.close().then(() => app.quit());
        }
    } });
    app.on('window-all-closed', () => app.quit());
}
