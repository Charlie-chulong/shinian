import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu,
  nativeImage, nativeTheme, session, shell, Tray,
  type IpcMainInvokeEvent, type MenuItemConstructorOptions,
} from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppInfo, AppState, Command, FileResult, Settings } from '../src/shared/types';
import { StateStore } from './store';
import { CHANNELS } from './channels';

app.setName('Shinian');
app.setAppUserModelId('com.shinian.desktop');

const rendererPath = path.resolve(__dirname, '../dist/index.html');
const rendererDirectory = path.dirname(rendererPath);
const preloadPath = path.resolve(__dirname, 'preload.cjs');
const mutationChannels = new Set<string>([CHANNELS.dispatch, CHANNELS.import, CHANNELS.restore, CHANNELS.export]);
const notices = new Map<string, string>();
let store: StateStore;
let mainWindow: BrowserWindow | null = null;
let quickWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let drainedForQuit = false;
let quitDrainInProgress = false;
let lastSettings: Settings | undefined;
let shortcutRegistered = false;
let configuredShortcut = '';
let pendingQuick = false;
let pendingShowMain = false;
let applicationStarted = false;
let devUrl: URL | undefined;

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function configureProfile(): void {
  // An explicit Chromium profile switch also supports isolated packaged smoke
  // tests. Environment overrides and a live dev server are unpackaged-only.
  const profile = app.commandLine.getSwitchValue('user-data-dir') || (!app.isPackaged ? process.env.SHINIAN_DATA_DIR : undefined);
  if (profile) {
    const resolved = path.resolve(profile);
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    app.setPath('userData', resolved);
  }
  if (!app.isPackaged && process.env.SHINIAN_DEV_URL) {
    const candidate = new URL(process.env.SHINIAN_DEV_URL);
    if (!['http:', 'https:'].includes(candidate.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(candidate.hostname) || candidate.username || candidate.password) {
      throw new Error('SHINIAN_DEV_URL 必须指向本机开发服务器');
    }
    devUrl = candidate;
  }
}

function alive(window: BrowserWindow | null): window is BrowserWindow {
  return !!window && !window.isDestroyed();
}

function trayCanRestore(): boolean {
  // Electron has no API confirming that a Linux tray host is actually visible.
  // A successfully constructed Tray alone must never leave Linux users trapped.
  return process.platform !== 'linux' && !!tray && !tray.isDestroyed();
}

function trustedDocument(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (devUrl) {
      return url.origin === devUrl.origin && [devUrl.pathname, '/index.html'].includes(url.pathname);
    }
    return url.protocol === 'file:' && url.hostname === '' && path.resolve(fileURLToPath(url)) === rendererPath;
  } catch { return false; }
}

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!alive(window) || (window !== mainWindow && window !== quickWindow) || event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !trustedDocument(event.senderFrame.url)) {
    throw new Error('已拒绝来自非授权窗口的操作');
  }
  return window;
}

function restrictSession(): void {
  const currentSession = session.defaultSession;
  currentSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  currentSession.setPermissionCheckHandler(() => false);
  currentSession.setDevicePermissionHandler(() => false);
  currentSession.on('will-download', event => event.preventDefault());
  currentSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      if (url.protocol === 'file:') {
        const relative = path.relative(rendererDirectory, fileURLToPath(url));
        allowed = !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
      } else if (devUrl && ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
        allowed = url.hostname === devUrl.hostname && url.port === devUrl.port;
      } else if (['data:', 'blob:'].includes(url.protocol)) {
        allowed = true;
      } else if (!app.isPackaged && url.protocol === 'devtools:') {
        allowed = true;
      }
    } catch { /* Unknown URLs remain blocked. */ }
    callback({ cancel: !allowed });
  });
}

function protectWindow(window: BrowserWindow, quick: boolean): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    window.show(); window.focus();
    const response = dialog.showMessageBoxSync(window, {
      type: 'warning', title: '还有未保存的内容', message: '当前窗口还有未保存的内容。',
      detail: '继续编辑可以保留当前草稿。放弃后，这些未保存的修改将丢失。',
      buttons: ['继续编辑', '放弃未保存内容'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response === 1) event.preventDefault(); // Electron: preventing this event permits unloading.
    else { quitting = false; drainedForQuit = false; quitDrainInProgress = false; window.show(); window.focus(); }
  });
  window.on('close', event => {
    if (quitting) return;
    if (quick || (lastSettings?.closeToTray && trayCanRestore())) {
      event.preventDefault();
      void store.flush().then(() => { if (alive(window) && !quitting) window.hide(); });
      return;
    }
    if (!quick && process.platform !== 'darwin') {
      event.preventDefault();
      app.quit();
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (quitting || details.reason === 'clean-exit') return;
    notices.set('renderer', '窗口进程意外退出。已保存的内容仍在本机，尚未保存的草稿可能无法恢复。');
    void dialog.showMessageBox(window, {
      type: 'error', title: '窗口需要重新打开', message: '拾念窗口意外退出。',
      detail: '已保存的内容不受影响。重新打开窗口后可以继续使用。', buttons: ['重新打开', '关闭'], defaultId: 0,
    }).then(result => { if (result.response === 0 && alive(window)) window.reload(); });
  });
}

async function loadWindow(window: BrowserWindow, quick: boolean): Promise<void> {
  if (devUrl) {
    const url = new URL(devUrl);
    if (quick) url.searchParams.set('quick', '1');
    await window.loadURL(url.href);
  } else {
    await window.loadFile(rendererPath, quick ? { query: { quick: '1' } } : undefined);
  }
}

function newWindow(quick: boolean): BrowserWindow {
  const window = new BrowserWindow({
    title: quick ? '速记 · 拾念' : '拾念 · Shinian',
    width: quick ? 600 : 1360, height: quick ? 460 : 900,
    minWidth: quick ? 460 : 900, minHeight: quick ? 360 : 640,
    frame: true, show: false, autoHideMenuBar: true,
    alwaysOnTop: quick || !!lastSettings?.alwaysOnTop,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14171c' : '#f6f4f0',
    icon: path.join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: preloadPath, nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, spellcheck: false, devTools: !app.isPackaged,
    },
  });
  if (quick) quickWindow = window; else mainWindow = window;
  protectWindow(window, quick);
  window.once('ready-to-show', () => {
    if (!alive(window)) return;
    if (!quick && process.argv.includes('--login') && lastSettings?.closeToTray && trayCanRestore()) return;
    window.show(); window.focus();
  });
  window.on('closed', () => { if (quick) quickWindow = null; else mainWindow = null; });
  void loadWindow(window, quick).catch(error => {
    if (quitting) return;
    dialog.showErrorBox('拾念无法加载界面', `请保留数据目录，并重新解压完整应用。\n${describe(error)}`);
    if (alive(window)) window.show();
  });
  return window;
}

function showMain(): void {
  if (quitting) return;
  if (!app.isReady() || !applicationStarted) { pendingShowMain = true; return; }
  const window = alive(mainWindow) ? mainWindow : newWindow(false);
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}

function showQuick(): void {
  if (quitting) return;
  if (!app.isReady() || !applicationStarted) { pendingQuick = true; return; }
  const window = alive(quickWindow) ? quickWindow : newWindow(true);
  if (window.isMinimized()) window.restore();
  window.setAlwaysOnTop(true);
  window.show(); window.focus();
}

function registerShortcut(desired: string): void {
  if (configuredShortcut === desired && desired && isShortcutLive()) {
    shortcutRegistered = true; return;
  }
  if (configuredShortcut) {
    try { globalShortcut.unregister(configuredShortcut); } catch { /* It may already have been unregistered by the OS. */ }
  }
  configuredShortcut = desired;
  shortcutRegistered = false;
  notices.delete('shortcut');
  if (!desired) return;
  try {
    shortcutRegistered = globalShortcut.register(desired, showQuick);
    if (!shortcutRegistered) notices.set('shortcut', `全局速记快捷键 ${desired} 注册失败，可能已被其他应用占用。请在设置中更换；仍可使用应用内速记按钮。`);
  } catch (error) {
    notices.set('shortcut', `全局速记快捷键 ${desired} 无法使用：${describe(error)}。请在设置中更换。`);
  }
}

function isShortcutLive(): boolean {
  if (!configuredShortcut) return false;
  try { return globalShortcut.isRegistered(configuredShortcut); } catch { return false; }
}

function syncSystemSettings(settings: Settings): void {
  nativeTheme.themeSource = settings.theme;
  if (alive(mainWindow)) mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  if (!lastSettings || settings.quickShortcut !== lastSettings.quickShortcut) registerShortcut(settings.quickShortcut);
  if (!lastSettings || settings.startOnLogin !== lastSettings.startOnLogin) {
    const supported = process.platform === 'win32' || process.platform === 'darwin';
    notices.delete('login');
    if (settings.startOnLogin && !supported) {
      notices.set('login', '当前系统不支持应用内设置开机启动，此偏好未应用。');
    } else if (settings.startOnLogin && !app.isPackaged) {
      notices.set('login', '开发运行模式不注册开机启动。请在正式桌面应用中开启。');
    } else if (supported && app.isPackaged) {
      try {
        const login = { openAtLogin: settings.startOnLogin, path: process.execPath, args: ['--login'] };
        app.setLoginItemSettings(login);
        const actual = app.getLoginItemSettings({ path: login.path, args: login.args }).openAtLogin;
        if (actual !== settings.startOnLogin) notices.set('login', '开机启动偏好未能在系统中生效，请检查系统的登录项设置。');
      } catch (error) { notices.set('login', `无法更新开机启动：${describe(error)}`); }
    }
  }
  if (settings.closeToTray && !trayCanRestore()) {
    notices.set('tray-close', process.platform === 'linux'
      ? '当前电脑关闭主窗口后会退出拾念；需要快捷记录时请最小化窗口。'
      : '系统托盘暂不可用；关闭主窗口将退出应用，避免窗口隐藏后无法找回。');
  } else notices.delete('tray-close');
  lastSettings = structuredClone(settings);
}

function createTray(): void {
  try {
    let icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon.png'));
    if (icon.isEmpty()) throw new Error('托盘图标缺失');
    icon = icon.resize({ width: process.platform === 'darwin' ? 22 : 20, height: process.platform === 'darwin' ? 22 : 20 });
    tray = new Tray(icon);
    tray.setToolTip('拾念 · 随手记录，安心去做');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开拾念', click: showMain },
      { label: '快速记录', click: showQuick },
      { type: 'separator' },
      { label: '退出拾念', click: () => app.quit() },
    ]));
    tray.on('click', showMain);
    tray.on('double-click', showMain);
  } catch (error) {
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
    notices.set('tray', `系统托盘不可用：${describe(error)}`);
  }
}

function getInfo(): AppInfo {
  const warning = [...new Set([store?.warning, notices.get('startup'), notices.get('renderer')].filter(Boolean))].join('\n');
  const systemNotice = [...new Set([...notices].filter(([key]) => !['startup', 'renderer'].includes(key)).map(([, value]) => value))].join('\n');
  return {
    version: app.getVersion(), platform: process.platform, dataPath: store?.dataDir ?? app.getPath('userData'),
    shortcutRegistered: shortcutRegistered && isShortcutLive(),
    storageWarning: warning || undefined, systemNotice: systemNotice || undefined, mode: 'desktop',
  };
}

function dateLabel(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function exportData(window: BrowserWindow, format: unknown): Promise<FileResult> {
  if (format !== 'json' && format !== 'markdown') throw new Error('导出格式无效');
  const extension = format === 'json' ? 'json' : 'md';
  const result = await dialog.showSaveDialog(window, {
    title: format === 'json' ? '导出拾念完整备份' : '导出为 Markdown',
    defaultPath: path.join(app.getPath('documents'), `拾念-${dateLabel()}.${extension}`),
    buttonLabel: '导出', filters: [{ name: format === 'json' ? '拾念 JSON 备份' : 'Markdown 文档', extensions: [extension] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  if (quitting) throw new Error('应用正在退出，导出未执行。取消退出后可以重试。');
  await store.exportFile(result.filePath, format);
  return { canceled: false, path: result.filePath };
}

async function importData(window: BrowserWindow): Promise<FileResult> {
  const result = await dialog.showOpenDialog(window, {
    title: '导入并合并拾念备份', buttonLabel: '选择备份',
    filters: [{ name: '拾念 JSON 备份', extensions: ['json'] }], properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const selected = result.filePaths[0];
  const imported = await store.readImport(selected);
  const deleted = imported.items.filter(item => item.deletedAt !== null).length;
  const confirmation = await dialog.showMessageBox(window, {
    type: 'question', title: '确认合并导入', message: `合并 ${imported.projects.length} 个项目和 ${imported.items.length} 条记录？`,
    detail: `文件：${path.basename(selected)}\n其中回收站记录 ${deleted} 条。\n现有内容会保留；冲突记录会保留双方内容。导入前会自动备份当前工作区，当前应用设置保持不变。`,
    buttons: ['取消', '备份并合并'], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (confirmation.response !== 1) return { canceled: true };
  if (quitting) throw new Error('应用正在退出，导入未执行。取消退出后可以重试。');
  const state = await store.importState(imported);
  return { canceled: false, path: selected, state };
}

async function restoreBackup(window: BrowserWindow, value: unknown): Promise<AppState | null> {
  if (typeof value !== 'string') throw new Error('备份标识无效');
  const backup = await store.readBackup(value);
  const confirmation = await dialog.showMessageBox(window, {
    type: 'warning', title: '恢复工作区备份', message: '用此备份恢复工作区？',
    detail: `${value}\n${backup.projects.length} 个项目，${backup.items.length} 条记录。\n工作区及应用设置将恢复为备份中的内容。恢复前会另存当前工作区的安全备份，可再次恢复。`,
    buttons: ['取消', '备份当前内容并恢复'], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (confirmation.response !== 1) return null;
  if (quitting) throw new Error('应用正在退出，恢复未执行。取消退出后可以重试。');
  return store.restoreBackup(value, backup);
}

function bindIpc(): void {
  const handle = (channel: string, operation: (window: BrowserWindow, args: unknown[]) => unknown | Promise<unknown>) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const window = senderWindow(event);
      if (quitting && mutationChannels.has(channel)) {
        throw new Error('应用正在退出，本次操作未执行。取消退出后可以重试。');
      }
      try { return await operation(window, args); } catch (error) { throw new Error(describe(error)); }
    });
  };
  handle(CHANNELS.state, () => store.getState());
  handle(CHANNELS.info, () => getInfo());
  handle(CHANNELS.dispatch, async (_window, args) => {
    if (args.length !== 1 || !args[0] || typeof args[0] !== 'object') throw new Error('保存命令无效');
    const command = args[0] as Command;
    if (command.type === 'settings.update' && command.patch?.startOnLogin === true) {
      if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('当前系统不支持应用内设置开机启动');
      if (!app.isPackaged) throw new Error('请在正式桌面应用中开启开机启动；开发模式不会注册登录项');
    }
    const state = await store.dispatch(command);
    if (command.type === 'settings.update' && typeof command.patch?.quickShortcut === 'string') registerShortcut(state.settings.quickShortcut);
    return state;
  });
  handle(CHANNELS.export, (window, args) => exportData(window, args[0]));
  handle(CHANNELS.import, window => importData(window));
  handle(CHANNELS.openData, async () => {
    const error = await shell.openPath(store.dataDir);
    if (error) throw new Error(`无法打开数据文件夹：${error}`);
  });
  handle(CHANNELS.backups, () => store.listBackups());
  handle(CHANNELS.restore, (window, args) => restoreBackup(window, args[0]));
  handle(CHANNELS.quick, () => { showQuick(); });
  handle(CHANNELS.window, async (window, args) => {
    const action = args[0];
    if (!['minimize', 'maximize', 'close', 'hide', 'show-main'].includes(String(action))) throw new Error('窗口操作无效');
    await store.flush();
    if (!alive(window)) return;
    switch (action) {
      case 'minimize': if (window.isMinimizable()) window.minimize(); break;
      case 'maximize': if (window.isMaximizable()) { if (window.isMaximized()) window.unmaximize(); else window.maximize(); } break;
      case 'close': window.close(); break;
      case 'hide': if (window === quickWindow || trayCanRestore()) window.hide(); else window.minimize(); break;
      case 'show-main': showMain(); if (window === quickWindow) window.hide(); break;
    }
  });
}

function nativeAction(action: (window: BrowserWindow) => Promise<unknown>): () => void {
  return () => {
    const window = alive(mainWindow) ? mainWindow : newWindow(false);
    void action(window).catch(error => { if (alive(window)) void dialog.showMessageBox(window, { type: 'error', title: '操作未完成', message: describe(error), buttons: ['知道了'] }); });
  };
}

function setMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ label: '拾念', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: '退出拾念' }] } as MenuItemConstructorOptions] : []),
    { label: '文件', submenu: [
      { label: '打开主窗口', click: showMain },
      { label: '快速记录', accelerator: 'CommandOrControl+Shift+N', click: showQuick },
      { type: 'separator' },
      { label: '导出 JSON 备份…', click: nativeAction(window => exportData(window, 'json')) },
      { label: '导出 Markdown…', click: nativeAction(window => exportData(window, 'markdown')) },
      { label: '导入并合并…', click: nativeAction(importData) },
      { type: 'separator' },
      { label: '退出拾念', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '切换全屏' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start(): Promise<void> {
  restrictSession();
  store = new StateStore(app.getPath('userData'));
  try { await store.initialise(); } catch (error) {
    // Renderer's getState also rejects, so it can show a persistent recovery screen.
    notices.set('startup', describe(error));
  }
  createTray();
  try { const state = await store.getState(); syncSystemSettings(state.settings); } catch { /* Stored failure is visible through getInfo/getState. */ }
  store.subscribe(state => {
    try { syncSystemSettings(state.settings); notices.delete('settings'); } catch (error) { notices.set('settings', `偏好已保存，但部分系统设置未生效：${describe(error)}`); }
    for (const window of [mainWindow, quickWindow]) {
      if (alive(window) && !window.webContents.isDestroyed()) {
        try { window.webContents.send(CHANNELS.changed, state); } catch { /* Window closed between the liveness check and broadcast. */ }
      }
    }
  });
  bindIpc();
  setMenu();
  newWindow(false);
  applicationStarted = true;
  if (pendingShowMain) showMain();
  if (pendingQuick || process.argv.includes('--quick')) showQuick();
}

try {
  configureProfile();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', (_event, commandLine) => { if (commandLine.includes('--quick')) showQuick(); else showMain(); });
    app.on('activate', showMain);
    app.on('before-quit', event => {
      quitting = true;
      if (drainedForQuit || !store) return;
      event.preventDefault();
      if (quitDrainInProgress) return;
      quitDrainInProgress = true;
      // Do the asynchronous drain before closing the renderers. Restarting quit
      // from a prevented will-quit can leave Chromium alive with no windows.
      void store.flush().finally(() => {
        setImmediate(() => {
          quitDrainInProgress = false;
          if (!quitting) return;
          drainedForQuit = true;
          app.quit();
        });
      });
    });
    app.on('window-all-closed', () => { if (process.platform !== 'darwin' || quitting) app.quit(); });
    app.on('will-quit', () => {
      globalShortcut.unregisterAll();
      if (tray && !tray.isDestroyed()) tray.destroy();
    });
    void app.whenReady().then(start).catch(error => {
      dialog.showErrorBox('拾念无法启动', describe(error));
      app.exit(1);
    });
  }
} catch (error) {
  void app.whenReady().then(() => { dialog.showErrorBox('拾念无法打开此数据目录', describe(error)); app.exit(1); });
}
