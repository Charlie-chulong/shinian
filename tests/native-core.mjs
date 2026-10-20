import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// Run after npm run build, under an actual display or Xvfb. Dialog selections are
// stubbed in the main process; the real preload, IPC and filesystem code execute.
// --no-sandbox is required by this root-owned CI container, not by the shipped app.
const root = process.cwd();
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'shinian-native-core-'));
const profile = path.join(temporary, 'profile');
const output = path.join(temporary, 'exports');
await fs.mkdir(output, { recursive: true });
let application;
let passed = false;
const checks = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };

async function launch() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.SHINIAN_DEV_URL;
  delete environment.SHINIAN_DATA_DIR;
  application = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '.'],
    cwd: root, env: { ...environment, DISPLAY: process.env.DISPLAY || ':91' }, timeout: 30000,
  });
  const page = await application.firstWindow();
  await page.waitForFunction(() => typeof window.shinian?.getState === 'function');
  await page.waitForSelector('.app-shell', { timeout: 20000 });
  return page;
}

async function closeApplication() {
  if (!application) return;
  const child = application.process();
  let timer;
  try {
    await Promise.race([
      application.close(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron did not quit within 10 seconds')), 10000); }),
    ]);
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw error;
  } finally { clearTimeout(timer); application = undefined; }
}

try {
  let page = await launch();
  const initial = await page.evaluate(() => window.shinian.getState());
  assert.equal(initial.items.length, 0);
  assert.equal(initial.projects.length, 0);
  assert.equal(initial.revision, 0);
  const info = await page.evaluate(() => window.shinian.getInfo());
  assert.equal(info.mode, 'desktop');
  assert.equal(info.dataPath, profile);
  const isolation = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process }));
  assert.deepEqual(isolation, { require: 'undefined', process: 'undefined' });
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  check('empty isolated desktop profile and restricted preload');

  await page.evaluate(() => {
    window.__nativeSeen = [];
    window.shinian.subscribe(state => window.__nativeSeen.push(state.revision));
  });
  await page.evaluate(() => Promise.all(Array.from({ length: 12 }, (_, index) => window.shinian.dispatch({ type: 'item.create', input: { title: `原生记录 ${index}` } }))));
  const quickEvent = application.waitForEvent('window');
  await page.evaluate(() => window.shinian.openQuickCapture());
  const quick = await quickEvent;
  await quick.waitForFunction(() => typeof window.shinian?.getState === 'function');
  assert.match(quick.url(), /quick=1/);
  await Promise.all([
    page.evaluate(() => Promise.all(Array.from({ length: 6 }, (_, index) => window.shinian.dispatch({ type: 'item.create', input: { title: `主窗口并发 ${index}` } })))),
    quick.evaluate(() => Promise.all(Array.from({ length: 6 }, (_, index) => window.shinian.dispatch({ type: 'item.create', input: { title: `速记并发 ${index}`, kind: 'todo' } })))),
  ]);
  let state = await page.evaluate(() => window.shinian.getState());
  assert.equal(state.items.length, 24);
  assert.equal(state.revision, 24);
  assert.equal(new Set(state.items.map(item => item.id)).size, 24);
  const seen = await page.evaluate(() => window.__nativeSeen);
  assert.deepEqual(seen, Array.from({ length: 24 }, (_, index) => index + 1));
  assert.deepEqual(await quick.evaluate(() => window.shinian.getState()), state);
  check('main and quick capture serialize and broadcast 24 committed saves');

  await page.evaluate(() => window.shinian.dispatch({ type: 'settings.update', patch: { alwaysOnTop: true, quickShortcut: '' } }));
  const windowSettings = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ quick: window.webContents.getURL().includes('quick=1'), top: window.isAlwaysOnTop() })));
  assert.equal(windowSettings.find(window => !window.quick).top, true);
  assert.equal(windowSettings.find(window => window.quick).top, true);
  assert.equal((await page.evaluate(() => window.shinian.getInfo())).shortcutRegistered, false);
  const accelerator = 'CommandOrControl+Alt+F12';
  await page.evaluate(value => window.shinian.dispatch({ type: 'settings.update', patch: { quickShortcut: value } }), accelerator);
  const shortcutInfo = await page.evaluate(() => window.shinian.getInfo());
  const nativeRegistered = await application.evaluate(({ globalShortcut }, value) => globalShortcut.isRegistered(value), accelerator);
  assert.equal(shortcutInfo.shortcutRegistered, nativeRegistered);
  if (!nativeRegistered) assert.match(shortcutInfo.storageWarning, /快捷键/);
  await page.evaluate(() => window.shinian.dispatch({ type: 'settings.update', patch: { quickShortcut: '' } }));
  const beforeInvalid = await page.evaluate(() => window.shinian.getState());
  await assert.rejects(page.evaluate(() => window.shinian.dispatch({ type: 'settings.update', patch: { startOnLogin: true } })));
  await assert.rejects(page.evaluate(() => window.shinian.dispatch({ type: 'item.purge', ids: ['../bad-id'] })));
  assert.deepEqual(await page.evaluate(() => window.shinian.getState()), beforeInvalid);
  await page.evaluate(() => window.shinian.dispatch({ type: 'settings.update', patch: { alwaysOnTop: false } }));
  check('native window preferences apply and rejected commands cannot mutate data');

  // A third local renderer with the preload is still not an authorized app window.
  const untrustedEvent = application.waitForEvent('window');
  const unauthorizedId = await application.evaluate(async ({ BrowserWindow }, rootPath) => {
    const window = new BrowserWindow({ show: false, webPreferences: { preload: `${rootPath}/dist-electron/preload.cjs`, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    await window.loadFile(`${rootPath}/dist/index.html`);
    return window.id;
  }, root);
  const unauthorized = await untrustedEvent;
  await unauthorized.waitForFunction(() => typeof window.shinian?.getState === 'function');
  await assert.rejects(unauthorized.evaluate(() => window.shinian.getState()), /非授权窗口/);
  const unauthorizedClosed = unauthorized.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), unauthorizedId);
  await unauthorizedClosed;
  const countBeforeOpen = application.windows().length;
  await page.evaluate(() => { window.open('https://example.com'); });
  assert.equal(application.windows().length, countBeforeOpen);
  await application.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('quick=1'));
    global.__nativeNavigation = new Promise(resolve => main.webContents.once('will-navigate', event => resolve(event.defaultPrevented)));
  });
  const beforeNavigation = page.url();
  await page.evaluate(() => { location.assign('https://example.com'); });
  assert.equal(await application.evaluate(() => global.__nativeNavigation), true);
  assert.equal(page.url(), beforeNavigation);
  check('IPC rejects foreign renderers; renderer windows and remote navigation are denied');

  const duplicate = spawn(path.join(root, 'node_modules/electron/dist/electron'), ['--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '.', '--quick'], {
    cwd: root, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':91' }, stdio: 'ignore',
  });
  const duplicateExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { duplicate.kill('SIGTERM'); reject(new Error('Second instance did not exit')); }, 10000);
    duplicate.once('error', error => { clearTimeout(timer); reject(error); });
    duplicate.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(duplicateExit, 0);
  assert.equal(application.windows().length, 2);
  assert.deepEqual(await page.evaluate(() => window.shinian.getState()), await quick.evaluate(() => window.shinian.getState()));
  check('a second process exits and reuses the existing profile owner and quick window');

  const jsonPath = path.join(output, 'export.json');
  const markdownPath = path.join(output, 'export.md');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, jsonPath);
  const exported = await page.evaluate(() => window.shinian.exportData('json'));
  assert.equal(exported.canceled, false);
  assert.equal(exported.path, jsonPath);
  state = await page.evaluate(() => window.shinian.getState());
  assert.deepEqual(JSON.parse(await fs.readFile(jsonPath, 'utf8')), state);
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, markdownPath);
  await page.evaluate(() => window.shinian.exportData('markdown'));
  assert.match(await fs.readFile(markdownPath, 'utf8'), /原生记录/);
  await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  assert.equal((await page.evaluate(() => window.shinian.exportData('json'))).canceled, true);
  check('native JSON and Markdown export paths execute real atomic writes and cancellation');

  const importedPath = path.join(output, 'import.json');
  const incoming = {
    ...initial, updatedAt: state.updatedAt,
    items: [{ ...state.items[0], id: 'native-import-record', title: '从 JSON 合并的记录', projectId: null }],
  };
  await fs.writeFile(importedPath, JSON.stringify(incoming));
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    dialog.showMessageBox = async (_window, options) => { global.__nativeConfirmation = options; return { response: 1, checkboxChecked: false }; };
  }, importedPath);
  const imported = await page.evaluate(() => window.shinian.importData());
  assert.equal(imported.canceled, false);
  assert.equal(imported.state.items.length, state.items.length + 1);
  const backups = await page.evaluate(() => window.shinian.listBackups());
  const beforeImport = backups.find(backup => backup.id.startsWith('before-import-'));
  assert.ok(beforeImport);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile, 'backups', beforeImport.id), 'utf8')), state);
  const restored = await page.evaluate(id => window.shinian.restoreBackup(id), beforeImport.id);
  assert.equal(restored.items.length, state.items.length);
  assert.ok(restored.revision > imported.state.revision);
  assert.ok((await page.evaluate(() => window.shinian.listBackups())).some(backup => backup.id.startsWith('before-restore-')));
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  const canceledRestore = await page.evaluate(id => window.shinian.restoreBackup(id), beforeImport.id);
  assert.equal(canceledRestore, null);
  assert.deepEqual(await page.evaluate(() => window.shinian.getState()), restored);
  check('native merge import and confirmed restore preserve safety backups; canceled restore is unchanged');

  await quick.evaluate(() => window.shinian.windowAction('close'));
  const quickWindow = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('quick=1'));
    return { exists: !!window, visible: window?.isVisible() };
  });
  assert.deepEqual(quickWindow, { exists: true, visible: false });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile, 'shinian.json'), 'utf8')), restored);
  await closeApplication();
  page = await launch();
  assert.deepEqual(await page.evaluate(() => window.shinian.getState()), restored);
  check('closing quick capture preserves its window and a new application process reloads exact saved state');

  await closeApplication();
  const corrupted = '{ native smoke deliberately corrupted this file';
  await fs.writeFile(path.join(profile, 'shinian.json'), corrupted);
  page = await launch();
  assert.deepEqual(await page.evaluate(() => window.shinian.getState()), restored);
  assert.match((await page.evaluate(() => window.shinian.getInfo())).storageWarning, /恢复/);
  const corruptPaths = await fs.readdir(path.join(profile, 'preserved-corrupt'));
  assert.ok(corruptPaths.length);
  assert.equal(await fs.readFile(path.join(profile, 'preserved-corrupt', corruptPaths[0]), 'utf8'), corrupted);
  check('fresh native startup recovers known-good state and preserves corrupt bytes');
  passed = true;
  console.log(`Native core verification passed: ${checks.length} groups.`);
} finally {
  if (application) await closeApplication();
  if (passed) await fs.rm(temporary, { recursive: true, force: true });
  else console.error(`Native smoke diagnostics retained at ${temporary}`);
}
