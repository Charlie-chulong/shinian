/**
 * Controlled renderer bridge delay/fault tests, NOT native storage verification.
 *
 * These 15 cases run the real React components and domain reducer in Electron.
 * The bridge is an in-memory fixture: delays, write failures, deletion events,
 * backup notices, and window actions are controlled by the test. Passing this
 * suite does not establish native IPC/disk durability, tray/shortcut behavior,
 * OS window hiding, or production close/quit behavior. Fixture cleanup uses
 * BrowserWindow.destroy(); production lifecycle tests are separate.
 *
 * Run from the project root after npm install:
 *   node tests/renderer-stress.mjs
 * Linux requires a running X server; DISPLAY is respected, with :91 as fallback.
 * You can also use: xvfb-run -a node tests/renderer-stress.mjs
 *
 * Dependencies come from this project's installed Electron/Playwright/esbuild.
 * Builds and the isolated Electron profile use an OS mkdtemp directory.
 * Logs/screenshots go only to test-results/ and must stay out of release ZIPs.
 */
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const resultDir = path.join(root, 'test-results');
const screenshotDir = path.join(resultDir, 'renderer-stress');
const logPath = path.join(resultDir, 'renderer-stress.log');
await fs.mkdir(screenshotDir, { recursive: true });
writeFileSync(logPath, '', 'utf8');
function log(message) {
  const text = String(message);
  process.stdout.write(`${text}\n`);
  appendFileSync(logPath, `${text}\n`, 'utf8');
}
log(`Renderer stress test started: ${new Date().toISOString()}`);
log('Scope: controlled in-memory bridge delays/faults; NOT native storage or production lifecycle verification.');
log('Fixture windows are destroyed during cleanup. Screenshots/logs are test artifacts, not release assets.');

let electronApp;
let tempDir;
const startedAt = Date.now();
async function run() {
  const fixturePath = path.join(root, 'tests', 'fixtures', 'renderer-stress.tsx');
  await fs.access(path.join(root, 'package.json'));
  await fs.access(fixturePath);
  const require = createRequire(path.join(root, 'package.json'));
  const { build } = require('esbuild');
  const { _electron } = require('playwright');
  const executablePath = require('electron');
  log(`Runtime: Node ${process.version}; Electron ${require('electron/package.json').version}; Playwright ${require('playwright/package.json').version}; ${process.platform}`);
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shinian-renderer-stress-'));
  const indexPath = path.join(tempDir, 'index.html');
  const mainPath = path.join(tempDir, 'main.cjs');
  const profilePath = path.join(tempDir, 'profile');
  await build({
    entryPoints: [fixturePath], outfile: path.join(tempDir, 'app.js'),
    bundle: true, platform: 'browser', jsx: 'automatic',
    loader: { '.woff2': 'file' }, assetNames: 'assets/[name]-[hash]',
    define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
  });
  await Promise.all([
    fs.writeFile(indexPath, '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>拾念 · 受控交互测试</title><link rel="stylesheet" href="./app.css"></head><body><div id="root"></div><script src="./app.js"></script></body></html>'),
    fs.writeFile(mainPath, `const { app, BrowserWindow } = require('electron');
app.setName('ShinianRendererStress');
app.setPath('userData', ${JSON.stringify(profilePath)});
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 400, height: 200, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  window.loadURL('about:blank');
});\n`),
  ]);
  const display = process.env.DISPLAY || ':91';
  log(`Display: ${display}; isolated fixture build/profile created with mkdtemp.`);
  electronApp = await _electron.launch({
    executablePath, args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN', mainPath],
    env: { ...process.env, DISPLAY: display }, timeout: 30_000,
  });
  await electronApp.firstWindow();
  const base = pathToFileURL(indexPath).href;
  const failures = [];
  let passed = 0;
  let caseNumber = 0;
  async function check(name, runCase, { quick = false } = {}) {
    const number = ++caseNumber;
    const partition = `renderer-stress-${number}`;
    const windowIds = [];
    const errors = [];
    let page;
    const context = {
      newPage: async () => {
        const opened = electronApp.waitForEvent('window');
        const id = await electronApp.evaluate(({ BrowserWindow }, options) => {
          const window = new BrowserWindow({
            width: options.quick ? 600 : 1100, height: options.quick ? 460 : 850,
            show: true, useContentSize: true,
            webPreferences: { partition: options.partition, contextIsolation: true, sandbox: true, backgroundThrottling: false },
          });
          window.loadURL('about:blank');
          return window.id;
        }, { partition, quick });
        windowIds.push(id);
        const nextPage = await opened;
        nextPage.on('pageerror', error => errors.push(error.message));
        nextPage.setDefaultTimeout(8_000);
        return nextPage;
      },
    };
    try {
      page = await context.newPage();
      await page.goto(base + (quick ? '?quick=1' : ''));
      await page.locator(quick ? '#quick-title' : '#editor-title').waitFor();
      await runCase(page, context);
      assert.deepEqual(errors, [], 'No React/browser errors');
      passed++;
      log(`PASS ${String(number).padStart(2, '0')}/15 ${name}`);
    } catch (error) {
      failures.push({ number, name, message: error instanceof Error ? error.message : String(error) });
      log(`FAIL ${String(number).padStart(2, '0')}/15 ${name}: ${error instanceof Error ? error.stack : error}`);
      if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(screenshotDir, `failure-${number}.png`), fullPage: true })
          .catch(reason => log(`Failure screenshot unavailable: ${String(reason)}`));
      }
    } finally {
      await electronApp.evaluate(({ BrowserWindow }, ids) => ids.forEach(id => BrowserWindow.fromId(id)?.destroy()), windowIds);
    }
  }
  async function finalTitle(page, title) { await page.waitForFunction(value => window.testing.state().items[0].title === value, title); }
  async function countCommands(page, count) { await page.waitForFunction(value => window.testing.commands.length >= value, count); }

  await check('autosave changes only the edited title', async page => {
    await page.locator('#editor-title').fill('更新后的灵感');
    await finalTitle(page, '更新后的灵感');
    const commands = await page.evaluate(() => window.testing.commands);
    assert.equal(commands.length, 1);
    assert.deepEqual(Object.keys(commands[0].patch), ['title']);
    await page.locator('.editor-save-state-saved').waitFor();
  });

  await check('edits during pending save keep the newest title and body', async page => {
    await page.evaluate(() => { window.testing.delay = 650; });
    await page.locator('#editor-title').fill('第一版');
    await countCommands(page, 1);
    await page.locator('#editor-title').fill('第二版');
    await page.locator('#editor-body').fill('保存过程中继续写的正文');
    await finalTitle(page, '第一版');
    assert.equal(await page.locator('#editor-title').inputValue(), '第二版');
    assert.equal(await page.locator('#editor-body').inputValue(), '保存过程中继续写的正文');
    await finalTitle(page, '第二版');
    assert.equal(await page.evaluate(() => window.testing.state().items[0].body), '保存过程中继续写的正文');
    assert.equal(await page.evaluate(() => window.testing.commands.length), 2);
  });

  await check('reverting an in-flight value is saved back correctly', async page => {
    await page.evaluate(() => { window.testing.delay = 650; });
    await page.locator('#editor-title').fill('临时修改');
    await countCommands(page, 1);
    await page.locator('#editor-title').fill('原始标题');
    await countCommands(page, 2);
    await finalTitle(page, '原始标题');
    assert.equal(await page.locator('#editor-title').inputValue(), '原始标题');
  });

  await check('remote clean fields merge while dirty title stays local', async page => {
    await page.locator('#editor-title').fill('本地标题');
    await page.evaluate(() => window.testing.remote({ type: 'item.status', ids: [window.testing.itemId], status: 'doing', kind: 'todo' }));
    await page.waitForFunction(() => document.querySelector('#editor-status').value === 'doing');
    assert.equal(await page.locator('#editor-title').inputValue(), '本地标题');
    await finalTitle(page, '本地标题');
    assert.equal(await page.evaluate(() => window.testing.state().items[0].status), 'doing');
    assert.deepEqual(await page.evaluate(() => Object.keys(window.testing.commands[0].patch)), ['title']);
  });

  await check('newer revision wins over delayed response with same timestamp', async page => {
    await page.evaluate(() => { window.testing.responseDelay = 700; });
    await page.locator('#editor-title').fill('已保存的本地标题');
    await finalTitle(page, '已保存的本地标题');
    await page.evaluate(() => window.testing.remote({ type: 'item.update', id: window.testing.itemId, patch: { title: '之后到达的标题', body: '之后到达的正文' } }));
    await page.waitForFunction(() => document.querySelector('#editor-title').value === '之后到达的标题');
    assert.equal(await page.locator('#editor-body').inputValue(), '之后到达的正文');
    assert.equal(await page.evaluate(() => window.testing.commands.length), 1);
  });

  await check('save failure and failed close retain draft; retry succeeds', async page => {
    await page.evaluate(() => { window.testing.failCount = 2; });
    await page.locator('#editor-title').fill('不能丢掉的草稿');
    await page.locator('.editor-save-state-error').waitFor();
    assert.equal(await page.locator('#editor-title').inputValue(), '不能丢掉的草稿');
    await page.locator('#editor-title').press('Escape');
    await countCommands(page, 2);
    await page.waitForFunction(() => window.testing.errors.length === 2);
    assert.equal(await page.locator('[role="dialog"]').count(), 1);
    assert.equal(await page.evaluate(() => window.testing.closed), false);
    await page.getByRole('button', { name: '重试保存' }).click();
    await finalTitle(page, '不能丢掉的草稿');
    await page.getByRole('button', { name: '完成编辑' }).click();
    await page.locator('#closed').waitFor();
  });

  await check('close waits for controlled dispatch resolution and guards unload', async page => {
    await page.evaluate(() => { window.testing.delay = 650; });
    await page.locator('#editor-title').fill('关闭前写入');
    const prevented = await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
    assert.equal(prevented, true);
    await page.locator('#editor-title').press('Escape');
    await countCommands(page, 1);
    assert.equal(await page.evaluate(() => window.testing.closed), false);
    await page.locator('#closed').waitFor();
    assert.equal(await page.evaluate(() => window.testing.state().items[0].title), '关闭前写入');
  });

  await check('empty title cannot autosave or close; IME Escape does not close', async page => {
    await page.locator('#editor-title').evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
    assert.equal(await page.locator('[role="dialog"]').count(), 1);
    await page.locator('#editor-title').fill('  ');
    await page.getByRole('button', { name: '完成编辑' }).click();
    await page.locator('.editor-validation').waitFor();
    assert.equal(await page.evaluate(() => window.testing.commands.length), 0);
    assert.equal(await page.locator('[role="dialog"]').count(), 1);
    await page.locator('#editor-title').fill('现在可以保存');
    await page.locator('#editor-title').press('Control+Enter');
    await page.locator('#closed').waitFor();
  });

  await check('save and close commits pending tag and subtask inputs', async page => {
    await page.locator('#editor-tag-input').fill('待归档');
    await page.getByRole('textbox', { name: '添加子任务', exact: true }).fill('下一小步');
    await page.getByRole('textbox', { name: '添加子任务', exact: true }).press('Control+Enter');
    await page.locator('#closed').waitFor();
    const item = await page.evaluate(() => window.testing.state().items[0]);
    assert.deepEqual(item.tags, ['待归档']);
    assert.equal(item.subtasks[0].text, '下一小步');
  });

  await check('remote delete retains uncommitted subtask and never recreates item', async page => {
    await page.getByRole('textbox', { name: '添加子任务', exact: true }).fill('尚未按回车的任务');
    await page.evaluate(() => window.testing.remote({ type: 'item.delete', ids: [window.testing.itemId] }));
    await page.locator('.editor-alert').waitFor();
    await page.getByRole('button', { name: '完成编辑' }).click();
    assert.equal(await page.getByRole('textbox', { name: '添加子任务', exact: true }).inputValue(), '尚未按回车的任务');
    assert.equal(await page.locator('[role="dialog"]').count(), 1);
    assert.equal(await page.evaluate(() => window.testing.commands.length), 0);
    assert.ok(await page.evaluate(() => window.testing.state().items[0].deletedAt));
  });

  await check('Markdown preview treats HTML as text and styles basic markup', async page => {
    await page.locator('#editor-body').fill('# 标题\n**加粗文字**\n<img src=x onerror="window.injected=true">\n- 清单一\n- 清单二');
    await page.getByRole('button', { name: '预览', exact: true }).click();
    assert.equal(await page.locator('.editor-markdown img').count(), 0);
    assert.equal(await page.locator('.editor-markdown strong').innerText(), '加粗文字');
    assert.match(await page.locator('.editor-markdown').innerText(), /<img src=x/);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.screenshot({ path: path.join(screenshotDir, 'editor.png'), fullPage: true });
  });

  await check('quick failure keeps draft; Escape caches; next window recovers', async (page, context) => {
    await page.locator('#quick-title').fill('快速窗草稿');
    await page.locator('#quick-body').fill('失败之后也要留住');
    await page.evaluate(() => { window.testing.failCount = 1; });
    await page.locator('#quick-body').press('Control+Enter');
    await page.locator('.quick-message-error').waitFor();
    assert.equal(await page.locator('#quick-title').inputValue(), '快速窗草稿');
    await page.locator('#quick-title').press('Escape');
    assert.deepEqual(await page.evaluate(() => window.testing.actions), ['hide']);
    const second = await context.newPage();
    await second.goto(base + '?quick=1');
    await second.locator('#quick-title').waitFor();
    assert.equal(await second.locator('#quick-title').inputValue(), '快速窗草稿');
    assert.equal(await second.locator('#quick-body').inputValue(), '失败之后也要留住');
  }, { quick: true });

  await check('quick IME shortcut is ignored; repeated submit creates once', async page => {
    await page.locator('#quick-title').fill('只保存一遍');
    await page.locator('#quick-title').evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })));
    assert.equal(await page.evaluate(() => window.testing.commands.length), 0);
    await page.evaluate(() => { window.testing.delay = 500; });
    await page.locator('#quick-title').press('Control+Enter');
    await countCommands(page, 1);
    await page.locator('.quick-app').evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    await page.waitForFunction(() => window.testing.actions.includes('hide'));
    assert.equal(await page.evaluate(() => window.testing.commands.length), 1);
    assert.equal(await page.locator('#quick-title').inputValue(), '');
    assert.equal(await page.evaluate(() => localStorage.getItem('shinian.quick.draft.v1')), null);
  }, { quick: true });

  await check('quick successful save leaves backup warning visible', async page => {
    await page.evaluate(() => { window.testing.infoWarning = '自动备份暂时无法写入，主要数据已保存。'; });
    await page.locator('#quick-title').fill('已安全保存的内容');
    await page.getByRole('button', { name: '收下灵感' }).click();
    await page.getByText('自动备份暂时无法写入，主要数据已保存。', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.quick-submit').disabled);
    assert.equal(await page.locator('#quick-title').inputValue(), '');
    assert.deepEqual(await page.evaluate(() => window.testing.actions), []);
    assert.equal(await page.evaluate(() => window.testing.state().items.length), 2);
  }, { quick: true });

  await check('quick follows project icons, theme and compact layout', async page => {
    const id = await page.evaluate(() => window.testing.state().projects[0].id);
    await page.locator('#quick-project-select').selectOption(id);
    assert.equal(await page.locator('.quick-project > span').innerText(), '✦');
    await page.evaluate(() => window.testing.remote({ type: 'settings.update', patch: { theme: 'dark' } }));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.locator('#quick-title').fill('一个还没想完整的点子');
    await page.locator('#quick-body').fill('也许可以把每一天的灵感，做成一张小卡片。');
    await page.screenshot({ path: path.join(screenshotDir, 'quick-dark.png'), fullPage: true });
    await page.evaluate(() => window.testing.remote({ type: 'settings.update', patch: { theme: 'light' } }));
    await page.screenshot({ path: path.join(screenshotDir, 'quick-light.png'), fullPage: true });
    await page.setViewportSize({ width: 460, height: 360 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.quick-submit').isVisible(), true);
  }, { quick: true });


  assert.equal(caseNumber, 15, 'The renderer stress suite must execute all 15 cases.');
  log(JSON.stringify({ scope: 'controlled-renderer-bridge', checks: caseNumber, passed, failures, elapsedMs: Date.now() - startedAt }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}

try {
  await run();
} catch (error) {
  log(`FATAL ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  if (electronApp) {
    let closeTimer;
    try {
      await Promise.race([
        electronApp.close(),
        new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Fixture cleanup timed out')), 10_000); }),
      ]);
    } catch (error) {
      log(`Fixture cleanup error: ${String(error)}`);
      electronApp.process().kill('SIGKILL');
      process.exitCode = 1;
    } finally { clearTimeout(closeTimer); }
  }
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(error => log(`Temporary fixture cleanup warning: ${String(error)}`));
  log(`Renderer stress test finished: ${new Date().toISOString()}; exit code ${process.exitCode || 0}`);
}
