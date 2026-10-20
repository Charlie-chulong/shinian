import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyCommand, createEmptyState, validateState } from '../src/shared/domain';
import { atomicWrite, DATA_FILENAME, RECOVERY_FILENAME, StateStore, type StoreIO, type StoreOptions } from '../electron/store';

const INITIAL = '2026-10-19T12:00:00.000Z';
const clock = () => new Date(INITIAL);

async function fixture(t: TestContext, options: StoreOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shinian-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory, { now: clock, ...options });
  await store.initialize();
  return { directory, store };
}

function ioError(code = 'EIO') { return Object.assign(new Error(`injected ${code}`), { code }); }
async function diskState(filePath: string) { return validateState(JSON.parse(await fs.readFile(filePath, 'utf8'))); }

test('first run is empty, durable, and detached from caller mutations', async t => {
  const { directory, store } = await fixture(t);
  const empty = await store.getState();
  assert.equal(empty.revision, 0);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.projects.length, 0);
  empty.settings.alwaysOnTop = true;
  assert.equal((await store.getState()).settings.alwaysOnTop, false);
  assert.deepEqual(await diskState(path.join(directory, DATA_FILENAME)), await store.getState());
  assert.deepEqual(await diskState(path.join(directory, RECOVERY_FILENAME)), await store.getState());
});

test('concurrent commands serialize without lost updates and notify only committed revisions', async t => {
  const { directory, store } = await fixture(t);
  const revisions: number[] = [];
  const unsubscribe = store.subscribe(state => { revisions.push(state.revision); state.items.length = 0; });
  const results = await Promise.all(Array.from({ length: 48 }, (_, index) => store.dispatch({ type: 'item.create', input: { title: `记录 ${index}` } })));
  assert.deepEqual(results.map(state => state.revision), Array.from({ length: 48 }, (_, index) => index + 1));
  assert.deepEqual(revisions, Array.from({ length: 48 }, (_, index) => index + 1));
  assert.equal((await store.getState()).items.length, 48);
  const reopened = new StateStore(directory, { now: clock });
  assert.equal((await reopened.getState()).items.length, 48);
  assert.deepEqual(await diskState(store.dataPath), await diskState(store.recoveryPath));
  unsubscribe();
});

test('a failed atomic rename preserves acknowledged memory and disk, and the command queue remains usable', async t => {
  let failPrimary = false;
  const io: StoreIO = { ...fs, rename: async (from, to) => {
    if (failPrimary && path.basename(String(to)) === DATA_FILENAME) { failPrimary = false; throw ioError(); }
    return fs.rename(from, to);
  } };
  const { store } = await fixture(t, { io });
  await store.dispatch({ type: 'item.create', input: { title: '原记录' } });
  const before = await store.getState();
  let notifications = 0;
  store.subscribe(() => { notifications++; });
  failPrimary = true;
  await assert.rejects(store.dispatch({ type: 'item.create', input: { title: '写入失败的记录' } }), /原有数据未被替换/);
  assert.deepEqual(await store.getState(), before);
  assert.deepEqual(await diskState(store.dataPath), before);
  assert.equal(notifications, 0);
  assert.match(store.warning!, /本次修改未保存/);
  const next = await store.dispatch({ type: 'item.create', input: { title: '重试成功' } });
  assert.equal(next.revision, before.revision + 1);
  assert.equal(next.items.length, 2);
  assert.equal(notifications, 1);
  assert.equal(store.warning, undefined);
});

test('a temporary file fsync failure never replaces the primary file or leaves a loaded partial state', async t => {
  let failSync = false;
  const io: StoreIO = { ...fs, open: (async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (failSync && path.basename(String(args[0])).startsWith(`.${DATA_FILENAME}.`)) {
      failSync = false;
      return new Proxy(handle, { get(target, property) {
        if (property === 'sync') return async () => { throw ioError('ENOSPC'); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    return handle;
  }) as typeof fs.open };
  const { directory, store } = await fixture(t, { io });
  const before = await store.getState();
  failSync = true;
  await assert.rejects(store.dispatch({ type: 'item.create', input: { title: '不应提交' } }), /ENOSPC/);
  assert.deepEqual(await diskState(store.dataPath), before);
  assert.deepEqual(await store.getState(), before);
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('a failure updating recovery after the commit reports a warning without falsely rejecting a saved change', async t => {
  let recoveryWrites = 0;
  let inject = false;
  const io: StoreIO = { ...fs, rename: async (from, to) => {
    if (inject && path.basename(String(to)) === RECOVERY_FILENAME && ++recoveryWrites === 2) throw ioError();
    return fs.rename(from, to);
  } };
  const { store } = await fixture(t, { io });
  inject = true;
  const committed = await store.dispatch({ type: 'item.create', input: { title: '主文件已保存' } });
  assert.equal(committed.items.length, 1);
  assert.deepEqual(await diskState(store.dataPath), committed);
  assert.equal((await diskState(store.recoveryPath)).revision, 0);
  assert.match(store.warning!, /内容已保存.*恢复副本更新失败/);
});

test('corrupted primary recovers latest valid data and preserves the exact corrupt bytes', async t => {
  const { directory, store } = await fixture(t);
  const expected = await store.dispatch({ type: 'item.create', input: { title: '会恢复的记录' } });
  const corrupt = Buffer.from([0x7b, 0x22, 0xff, 0x00, 0x42]);
  await fs.writeFile(store.dataPath, corrupt);
  const recovered = new StateStore(directory, { now: clock });
  assert.deepEqual(await recovered.getState(), expected);
  assert.match(recovered.warning!, /已从 latest-good.json 恢复/);
  const files = await fs.readdir(recovered.corruptDir);
  assert.equal(files.length, 1);
  assert.deepEqual(await fs.readFile(path.join(recovered.corruptDir, files[0])), corrupt);
  assert.deepEqual(await diskState(store.dataPath), expected);
});

test('invalid primary and latest recovery fall back to a validated daily backup', async t => {
  const { directory, store } = await fixture(t);
  const expected = await store.dispatch({ type: 'item.create', input: { title: '日备份记录' } });
  await fs.writeFile(store.dataPath, '{ broken primary');
  await fs.writeFile(store.recoveryPath, '{ broken recovery');
  const recovered = new StateStore(directory, { now: clock });
  assert.deepEqual(await recovered.getState(), expected);
  assert.match(recovered.warning!, /auto-2026-10-19.json/);
  assert.equal((await fs.readdir(recovered.corruptDir)).length, 2);
});

test('unrecoverable corruption rejects reads and mutations without resetting or overwriting anything', async t => {
  const { directory, store } = await fixture(t);
  const corrupt = '{ definitely not data';
  await fs.writeFile(store.dataPath, corrupt);
  await fs.writeFile(store.recoveryPath, corrupt);
  const broken = new StateStore(directory, { now: clock });
  await assert.rejects(broken.getState(), /没有可验证的恢复副本/);
  await assert.rejects(broken.dispatch({ type: 'item.create', input: { title: '绝不能覆盖' } }), /不会创建空白工作区/);
  assert.equal(await fs.readFile(store.dataPath, 'utf8'), corrupt);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), corrupt);
  assert.match(broken.warning!, /现有文件已保留/);
});

test('a recovery preservation failure cannot overwrite the damaged primary', async t => {
  const { directory, store } = await fixture(t);
  await store.dispatch({ type: 'item.create', input: { title: '安全记录' } });
  const corrupt = '{ damaged';
  await fs.writeFile(store.dataPath, corrupt);
  const io: StoreIO = { ...fs, copyFile: async () => { throw ioError('EACCES'); } };
  const broken = new StateStore(directory, { now: clock, io });
  await assert.rejects(broken.getState(), /无法保留损坏文件/);
  assert.equal(await fs.readFile(store.dataPath, 'utf8'), corrupt);
});

test('failure preserving a damaged recovery copy also blocks later writes with a valid primary', async t => {
  const { directory, store } = await fixture(t);
  const before = await store.dispatch({ type: 'item.create', input: { title: '主文件有效' } });
  const corrupt = '{ damaged recovery';
  await fs.writeFile(store.recoveryPath, corrupt);
  const io: StoreIO = { ...fs, copyFile: async () => { throw ioError('EACCES'); } };
  const broken = new StateStore(directory, { now: clock, io });
  await assert.rejects(broken.getState(), /无法保留损坏文件/);
  await assert.rejects(broken.dispatch({ type: 'item.create', input: { title: '不能跳过保护' } }));
  assert.deepEqual(await diskState(store.dataPath), before);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), corrupt);
});

test('daily automatic snapshots retain the latest 14 calendar days and ignore unrelated files', async t => {
  let current = new Date('2026-10-01T12:00:00.000Z');
  const { store } = await fixture(t, { now: () => new Date(current) });
  await fs.writeFile(path.join(store.backupsDir, 'user-note.txt'), 'do not delete');
  for (let day = 1; day <= 17; day++) {
    current = new Date(`2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`);
    await store.dispatch({ type: 'item.create', input: { title: `第 ${day} 天` } });
  }
  const backups = await store.listBackups();
  assert.equal(backups.length, 14);
  assert.ok(backups.some(backup => backup.id === 'auto-2026-10-04.json'));
  assert.ok(backups.some(backup => backup.id === 'auto-2026-10-17.json'));
  assert.ok(!backups.some(backup => backup.id === 'auto-2026-10-03.json'));
  assert.equal((await store.readBackup('auto-2026-10-17.json')).items.length, 17);
  assert.equal(await fs.readFile(path.join(store.backupsDir, 'user-note.txt'), 'utf8'), 'do not delete');
});

test('merge imports and restores create pre-operation backups and maintain a monotonic revision', async t => {
  const { store } = await fixture(t);
  const original = await store.dispatch({ type: 'item.create', input: { title: '当前记录' } });
  const incoming = applyCommand(createEmptyState(INITIAL), { type: 'item.create', input: { title: '导入记录' } }, INITIAL);
  const imported = await store.importState(incoming);
  assert.equal(imported.items.length, 2);
  assert.equal(imported.revision, original.revision + 1);
  const importBackup = (await store.listBackups()).find(backup => backup.id.startsWith('before-import-'));
  assert.ok(importBackup);
  assert.deepEqual(await store.readBackup(importBackup.id), original);
  const restored = await store.restoreBackup(importBackup.id);
  assert.equal(restored.items.length, 1);
  assert.equal(restored.items[0].title, '当前记录');
  assert.equal(restored.revision, imported.revision + 1);
  const restoreBackup = (await store.listBackups()).find(backup => backup.id.startsWith('before-restore-'));
  assert.ok(restoreBackup);
  assert.deepEqual(await store.readBackup(restoreBackup.id), imported);
  assert.deepEqual(await diskState(store.dataPath), restored);
});

test('invalid imports, invalid backup paths and corrupt snapshots cannot mutate current data', async t => {
  const { store } = await fixture(t);
  const original = await store.dispatch({ type: 'item.create', input: { title: '保留' } });
  const backupsBefore = (await store.listBackups()).map(backup => backup.id).sort();
  await assert.rejects(store.importState({ schemaVersion: 99, items: [] }));
  await assert.rejects(store.restoreBackup('../shinian.json'), /备份标识无效/);
  await assert.rejects(store.restoreBackup('/tmp/auto-2026-10-19.json'), /备份标识无效/);
  await fs.writeFile(path.join(store.backupsDir, 'auto-2026-10-18.json'), '{ corrupt');
  await assert.rejects(store.restoreBackup('auto-2026-10-18.json'), /此备份无法恢复/);
  assert.deepEqual(await store.getState(), original);
  assert.deepEqual(await diskState(store.dataPath), original);
  const currentIds = (await store.listBackups()).map(backup => backup.id).filter(id => id !== 'auto-2026-10-18.json').sort();
  assert.deepEqual(currentIds, backupsBefore);
});

test('restoring a legitimate backup survives a system clock rollback', async t => {
  let current = new Date('2026-10-19T12:00:00.000Z');
  const { store } = await fixture(t, { now: () => new Date(current) });
  const saved = await store.dispatch({ type: 'item.create', input: { title: '时钟回拨前的记录' } });
  current = new Date('2026-10-18T12:00:00.000Z');
  const restored = await store.restoreBackup('auto-2026-10-19.json');
  assert.equal(restored.revision, saved.revision + 1);
  assert.equal(restored.items[0].title, '时钟回拨前的记录');
  assert.equal(restored.updatedAt, saved.updatedAt);
  assert.deepEqual(validateState(restored), restored);
});

test('native confirmation restores its exact validated selection even if the daily backup changes meanwhile', async t => {
  const { store } = await fixture(t);
  const selected = await store.dispatch({ type: 'item.create', input: { title: '确认时选中的版本' } });
  const prepared = await store.readBackup('auto-2026-10-19.json');
  const newer = await store.dispatch({ type: 'item.create', input: { title: '另一个窗口稍后写入' } });
  assert.equal((await store.readBackup('auto-2026-10-19.json')).items.length, 2);
  const restored = await store.restoreBackup('auto-2026-10-19.json', prepared);
  assert.deepEqual(restored.items, selected.items);
  assert.equal(restored.revision, newer.revision + 1);
  const backup = (await store.listBackups()).find(value => value.id.startsWith('before-restore-'));
  assert.ok(backup);
  assert.deepEqual((await store.readBackup(backup.id)).items, newer.items);
});

test('a failed pre-import or pre-restore backup aborts the operation before any primary mutation', async t => {
  let failSafetyBackup = false;
  const io: StoreIO = { ...fs, rename: async (from, to) => {
    if (failSafetyBackup && path.basename(String(to)).startsWith('before-')) throw ioError('ENOSPC');
    return fs.rename(from, to);
  } };
  const { store } = await fixture(t, { io });
  const before = await store.dispatch({ type: 'item.create', input: { title: '原始数据' } });
  const incoming = applyCommand(createEmptyState(INITIAL), { type: 'item.create', input: { title: '新数据' } }, INITIAL);
  failSafetyBackup = true;
  await assert.rejects(store.importState(incoming), /安全备份失败/);
  await assert.rejects(store.restoreBackup('auto-2026-10-19.json'), /安全备份失败/);
  assert.deepEqual(await store.getState(), before);
  assert.deepEqual(await diskState(store.dataPath), before);
});

test('exports round-trip full JSON, provide readable Markdown and cannot overwrite managed data', async t => {
  const { store } = await fixture(t);
  await store.dispatch({ type: 'item.create', input: { title: '写一本书', body: '从第一章开始', kind: 'todo' } });
  const exported = JSON.parse(await store.exportText('json'));
  assert.deepEqual(validateState(exported), await store.getState());
  assert.match(await store.exportText('markdown'), /写一本书/);
  assert.match(await store.exportText('markdown'), /从第一章开始/);
  await assert.rejects(store.exportFile(store.dataPath, 'markdown'), /数据目录之外/);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shinian-export-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const output = path.join(outputDir, 'backup.json');
  await store.exportFile(output, 'json');
  assert.deepEqual(await store.readImport(output), await store.getState());
});

test('atomic export failure preserves an existing destination', async t => {
  const { directory } = await fixture(t);
  const destination = path.join(directory, 'outside.txt');
  await fs.writeFile(destination, 'existing export');
  const io: StoreIO = { ...fs, rename: async () => { throw ioError(); } };
  await assert.rejects(atomicWrite(destination, 'new export', io), /原有数据未被替换/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'existing export');
});
