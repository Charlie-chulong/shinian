import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createDemoState, createEmptyState, localDate, mergeState, toMarkdown, validateState } from '../src/shared/domain';
import type { AppState, Command, Item, ItemInput } from '../src/shared/types';

const T0 = '2026-10-19T08:00:00.000Z';
const T1 = '2026-10-19T09:00:00.000Z';
const T2 = '2026-10-19T10:00:00.000Z';
const T3 = '2026-10-19T11:00:00.000Z';
const T4 = '2026-10-19T12:00:00.000Z';
const T5 = '2026-10-19T13:00:00.000Z';
const T6 = '2026-10-19T14:00:00.000Z';

function clone<T>(value: T): T { return structuredClone(value); }
function unsafeCommand(value: unknown): Command { return value as Command; }
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) frozen(entry);
    Object.freeze(value);
  }
  return value;
}
function createProject(state: AppState, name = '小小实验室', now = T0): AppState {
  return applyCommand(state, { type: 'project.create', name, color: '#AbC', icon: '✦' }, now);
}
function createItem(state: AppState, input: ItemInput = { title: '随手记下的想法' }, now = T1): AppState {
  return applyCommand(state, { type: 'item.create', input }, now);
}
function fixture(): AppState {
  let state = createProject(createEmptyState(T0));
  state = createItem(state, {
    title: '试着画一个小原型', body: '先把想法写清楚。', kind: 'todo', projectId: state.projects[0].id,
    tags: ['设计'], dueDate: '2026-10-20', priority: 'medium',
    subtasks: [{ id: 'subtask-one', text: '写下一句话目标', done: false }],
  });
  return state;
}
function assertValid(state: AppState): void { assert.deepEqual(validateState(state), state); }

test('first run is empty, time is normalized, and independent states do not share settings', () => {
  const state = createEmptyState('2026-10-19T10:00:00+02:00');
  assert.equal(state.updatedAt, T0);
  assert.deepEqual(state.items, []);
  assert.deepEqual(state.projects, []);
  assert.equal(state.revision, 0);
  assert.equal(state.settings.onboardingComplete, false);
  assert.equal(state.settings.quickShortcut, 'CommandOrControl+Alt+Space');
  const second = createEmptyState(T0);
  second.settings.theme = 'dark';
  assert.equal(state.settings.theme, 'system');
  assertValid(state);
});

test('commands are deterministic with injected time and return wholly detached immutable results', () => {
  const initial = frozen(fixture());
  const command: Command = {
    type: 'item.create',
    input: { title: '  Cafe\u0301  ', body: '段落一\r\n段落二\r第三行\n', tags: ['灵感', ' 灵感 ', 'cafe\u0301'], subtasks: [{ id: 's_new', text: ' 看一眼 ', done: false }] },
  };
  const before = JSON.stringify(initial);
  const result = applyCommand(initial, command, T2);
  assert.deepEqual(result, applyCommand(initial, command, T2));
  assert.equal(JSON.stringify(initial), before);
  assert.equal(result.revision, initial.revision + 1);
  assert.equal(result.items.at(-1)!.title, 'Café');
  assert.equal(result.items.at(-1)!.body, '段落一\n段落二\n第三行\n');
  assert.deepEqual(result.items.at(-1)!.tags, ['灵感', 'café']);
  assert.notEqual(result.items[0], initial.items[0]);
  assert.notEqual(result.items[0].subtasks, initial.items[0].subtasks);
  result.items.at(-1)!.subtasks[0].text = '新状态自己的内容';
  assert.equal(command.input.subtasks![0].text, ' 看一眼 ');
  result.items[0].subtasks[0].done = true;
  result.settings.theme = 'dark';
  assert.equal(initial.items[0].subtasks[0].done, false);
  assert.equal(initial.settings.theme, 'system');
});

test('idea to todo lifecycle keeps completion time stable until reopening', () => {
  let state = createItem(createEmptyState(T0));
  const id = state.items[0].id;
  assert.equal(state.items[0].kind, 'idea');
  assert.equal(state.items[0].status, 'open');
  state = applyCommand(state, { type: 'item.status', ids: [id], status: 'doing' }, T2);
  assert.equal(state.items[0].kind, 'todo');
  assert.equal(state.items[0].status, 'doing');
  assert.equal(state.items[0].completedAt, null);
  state = applyCommand(state, { type: 'item.status', ids: [id], status: 'done' }, T3);
  assert.equal(state.items[0].completedAt, T3);
  const repeated = applyCommand(state, { type: 'item.status', ids: [id], status: 'done' }, T4);
  assert.equal(repeated.items[0].completedAt, T3);
  assert.equal(repeated.items[0].updatedAt, T3, 'unchanged record is not spuriously edited');
  assert.equal(repeated.revision, state.revision + 1);
  state = applyCommand(repeated, { type: 'item.status', ids: [id], status: 'open' }, T5);
  assert.equal(state.items[0].completedAt, null);
  state = applyCommand(state, { type: 'item.status', ids: [id], status: 'done' }, T6);
  assert.equal(state.items[0].completedAt, T6);
  assertValid(state);
});

test('converting to idea reopens by default and honors explicit completion', () => {
  let state = createItem(createEmptyState(T0), { title: '下一步', kind: 'todo', status: 'done' });
  const id = state.items[0].id;
  state = applyCommand(state, { type: 'item.update', id, patch: { kind: 'idea' } }, T2);
  assert.equal(state.items[0].kind, 'idea');
  assert.equal(state.items[0].status, 'open');
  assert.equal(state.items[0].completedAt, null);
  state = applyCommand(state, { type: 'item.update', id, patch: { kind: 'idea', status: 'done' } }, T3);
  assert.equal(state.items[0].status, 'done');
  assert.equal(state.items[0].completedAt, T3);
  state = applyCommand(state, { type: 'item.status', ids: [id], kind: 'idea', status: 'doing' }, T4);
  assert.equal(state.items[0].status, 'open');
  assert.equal(state.items[0].kind, 'idea');
  const implicitTodo = createItem(createEmptyState(T0), { title: '正在行动', status: 'doing' });
  assert.equal(implicitTodo.items[0].kind, 'todo');
  assertValid(state);
});

test('parent completion and checklist completion are independent and all item fields survive edits', () => {
  let state = fixture();
  const item = state.items[0];
  state = applyCommand(state, { type: 'item.update', id: item.id, patch: { pinned: true, subtasks: [{ ...item.subtasks[0], done: true }], title: '新版标题' } }, T2);
  assert.equal(state.items[0].status, 'open');
  assert.equal(state.items[0].completedAt, null);
  assert.equal(state.items[0].body, item.body);
  assert.equal(state.items[0].projectId, item.projectId);
  assert.equal(state.items[0].dueDate, '2026-10-20');
  state = applyCommand(state, { type: 'item.update', id: item.id, patch: { subtasks: [{ ...item.subtasks[0], done: false }], status: 'done' } }, T3);
  assert.equal(state.items[0].subtasks[0].done, false);
  assert.equal(state.items[0].completedAt, T3);
  assertValid(state);
});

test('mass moves validate all records atomically and support moving back to the inbox', () => {
  let state = fixture();
  state = createItem(state, { title: '另一个想法' });
  state = createProject(state, '另一组', T2);
  const ids = state.items.map(item => item.id);
  const target = state.projects[1].id;
  const original = frozen(clone(state));
  assert.throws(() => applyCommand(original, { type: 'item.move', ids: [...ids, 'missing-item'], projectId: target }, T3), /不存在/);
  assert.deepEqual(original, state);
  assert.throws(() => applyCommand(original, { type: 'item.move', ids, projectId: 'missing-project' }, T3), /不存在/);
  state = applyCommand(state, { type: 'item.move', ids, projectId: target }, T3);
  assert.ok(state.items.every(item => item.projectId === target && item.updatedAt === T3));
  state = applyCommand(state, { type: 'item.move', ids, projectId: null }, T4);
  assert.ok(state.items.every(item => item.projectId === null));
  assertValid(state);
});

test('soft delete and project removal retain active and trash contents, then restore to inbox', () => {
  let state = fixture();
  const project = state.projects[0].id;
  state = createItem(state, { title: '项目里的另一条', projectId: project, kind: 'idea', status: 'done' });
  const first = clone(state.items[0]);
  const secondId = state.items[1].id;
  state = applyCommand(state, { type: 'item.delete', ids: [first.id] }, T2);
  assert.equal(state.items[0].deletedAt, T2);
  assert.equal(state.items[0].body, first.body);
  assert.throws(() => applyCommand(state, { type: 'item.update', id: first.id, patch: { title: '不可编辑' } }, T3), /先从回收站恢复/);
  const repeatedDelete = applyCommand(state, { type: 'item.delete', ids: [first.id] }, T3);
  assert.equal(repeatedDelete.items[0].deletedAt, T2);
  state = applyCommand(repeatedDelete, { type: 'project.delete', id: project }, T4);
  assert.equal(state.projects.length, 0);
  assert.ok(state.items.every(item => item.projectId === null));
  assert.equal(state.items[0].deletedAt, T2);
  assert.equal(state.items.find(item => item.id === secondId)!.status, 'done');
  assert.equal(state.items.find(item => item.id === secondId)!.completedAt, T1);
  state = applyCommand(state, { type: 'item.restore', ids: [first.id] }, T5);
  assert.equal(state.items[0].deletedAt, null);
  assert.equal(state.items[0].body, first.body);
  assert.deepEqual(state.items[0].subtasks, first.subtasks);
  assert.equal(state.items[0].dueDate, first.dueDate);
  assert.equal(state.items[0].updatedAt, T5);
  assertValid(state);
});

test('permanent purge rejects active or missing records before changing anything', () => {
  let state = fixture();
  state = createItem(state, { title: '仍然保留' });
  const [trashId, activeId] = state.items.map(item => item.id);
  state = applyCommand(state, { type: 'item.delete', ids: [trashId] }, T2);
  const snapshot = clone(state);
  assert.throws(() => applyCommand(state, { type: 'item.purge', ids: [trashId, activeId] }, T3), /只能永久删除回收站/);
  assert.throws(() => applyCommand(state, { type: 'item.purge', ids: [trashId, 'missing'] }, T3), /不存在/);
  assert.deepEqual(state, snapshot);
  const purged = applyCommand(state, { type: 'item.purge', ids: [trashId] }, T3);
  assert.deepEqual(purged.items.map(item => item.id), [activeId]);
  assert.equal(state.items.length, 2);
  assertValid(purged);
});

test('partial item and project reorder preserve the positions of records outside the selection', () => {
  let state = createEmptyState(T0);
  for (const title of ['A', 'B', 'C', 'D']) state = createItem(state, { title });
  const [a, b, c, d] = state.items.map(item => item.id);
  state = applyCommand(state, { type: 'item.reorder', ids: [c, a] }, T2);
  assert.deepEqual([...state.items].sort((x, y) => x.order - y.order).map(item => item.id), [c, b, a, d]);
  for (const name of ['甲', '乙', '丙']) state = createProject(state, name, T2);
  const [p1, p2, p3] = state.projects.map(project => project.id);
  state = applyCommand(state, { type: 'project.reorder', ids: [p3, p1] }, T3);
  assert.deepEqual(state.projects.map(project => project.id), [p3, p2, p1]);
  assert.throws(() => applyCommand(state, { type: 'item.reorder', ids: [a, a] }, T3), /不能重复/);
  assert.throws(() => applyCommand(state, { type: 'project.reorder', ids: ['missing'] }, T3), /不存在/);
  assertValid(state);
});

test('strict runtime command validation rejects misspellings, invalid values, and unexpected fields', () => {
  const state = fixture();
  const id = state.items[0].id;
  const invalid: unknown[] = [
    null, [], { type: 'state.replace', state }, { type: 'item.create', input: { title: ' ' } },
    { type: 'item.create', input: { title: '标题', administrator: true } },
    { type: 'item.update', id, patch: { id: 'renamed-id' } },
    { type: 'item.update', id, patch: { title: undefined } },
    { type: 'item.update', id, patch: { status: 'archived' } },
    { type: 'item.update', id, patch: { priority: 5 } },
    { type: 'item.update', id, patch: { pinned: 'yes' } },
    { type: 'item.delete', ids: [] }, { type: 'item.delete', ids: [id, id] },
    { type: 'item.delete', ids: [id], confirmed: true },
    { type: 'project.create', name: '计划', color: 'url(javascript:alert(1))', icon: '✦' },
    { type: 'project.create', name: '计划', color: '#fff', icon: 'a\nb' },
    { type: 'settings.update', patch: { theme: 'sepia' } },
    { type: 'settings.update', patch: { startOnLogin: 1 } },
    { type: 'demo.load', force: true },
  ];
  const before = clone(state);
  for (const command of invalid) assert.throws(() => applyCommand(state, unsafeCommand(command), T2));
  assert.deepEqual(state, before);
});

test('strict state validation rejects unsupported schemas, unknown data, duplicate IDs, and broken references', () => {
  const source = fixture();
  const badStates: unknown[] = [
    { ...source, schemaVersion: 2 }, { ...source, schemaVersion: '1' }, { ...source, unknownField: true },
    { ...source, revision: -1 }, { ...source, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...source, items: [...source.items, clone(source.items[0])] },
    { ...source, projects: [...source.projects, clone(source.projects[0])] },
    { ...source, items: [{ ...source.items[0], projectId: 'missing-project' }] },
    { ...source, items: [{ ...source.items[0], id: '../outside' }] },
    { ...source, items: [{ ...source.items[0], order: NaN }] },
    { ...source, items: [{ ...source.items[0], order: Infinity }] },
    { ...source, settings: { ...source.settings, telemetry: true } },
    { ...source, items: [{ ...source.items[0], subtasks: [...source.items[0].subtasks, ...source.items[0].subtasks] }] },
  ];
  assert.throws(() => validateState({ ...source, schemaVersion: 8 }), /不支持此数据版本/);
  for (const bad of badStates) assert.throws(() => validateState(bad));
  const missing = clone(source) as unknown as { settings?: unknown };
  delete missing.settings;
  assert.throws(() => validateState(missing), /缺少字段/);
  const validated = validateState(source);
  validated.items[0].tags.push('新标签');
  assert.deepEqual(source.items[0].tags, ['设计']);
});

test('prototype pollution, inherited objects, and getter payloads are rejected without executing getters', () => {
  const state = fixture();
  let called = 0;
  const getterCommand = Object.defineProperty({}, 'type', { enumerable: true, get() { called += 1; return 'demo.load'; } });
  assert.throws(() => applyCommand(state, unsafeCommand(getterCommand), T2), /访问器/);
  const inherited = Object.assign(Object.create({ schemaVersion: 1 }), state);
  assert.throws(() => validateState(inherited), /自定义原型/);
  const polluted = clone(state);
  Object.defineProperty(polluted.settings, '__proto__', { value: { shinianPolluted: true }, enumerable: true });
  assert.throws(() => validateState(polluted), /不支持或不安全/);
  const subtask = JSON.parse('{"id":"subtask-safe","text":"任务","done":false,"__proto__":{"shinianPolluted":true}}');
  assert.throws(() => applyCommand(state, unsafeCommand({ type: 'item.update', id: state.items[0].id, patch: { subtasks: [subtask] } }), T2), /不支持或不安全/);
  const arrayWithGetter: unknown[] = [];
  Object.defineProperty(arrayWithGetter, '0', { enumerable: true, get() { called += 1; return state.items[0]; } });
  assert.throws(() => validateState({ ...state, items: arrayWithGetter }), /数组访问器/);
  const sparse = new Array(1);
  assert.throws(() => validateState({ ...state, items: sparse }), /空位/);
  assert.equal(called, 0);
  assert.equal(({} as { shinianPolluted?: boolean }).shinianPolluted, undefined);
  assert.throws(() => mergeState(state, polluted, T2));
  assertValid(state);
});

test('oversized fields fail clearly instead of truncating while large valid notes remain intact', () => {
  const state = createEmptyState(T0);
  const body = `${'长一点的灵感文字。'.repeat(15_000)}\n下一段保持完整。\n`;
  const result = createItem(state, { title: '题'.repeat(1_000), body, tags: ['标'.repeat(80)], subtasks: [{ id: 's1', text: '步'.repeat(1_000), done: false }] });
  assert.equal(result.items[0].title.length, 1_000);
  assert.equal(result.items[0].body, body);
  for (const input of [
    { title: '题'.repeat(1_001) }, { title: '有效标题', body: '字'.repeat(1_000_001) },
    { title: '有效标题', tags: ['标'.repeat(81)] }, { title: '有效标题', tags: Array.from({ length: 65 }, (_, index) => `tag-${index}`) },
    { title: '有效标题', subtasks: [{ id: 's1', text: '字'.repeat(1_001), done: false }] },
  ]) assert.throws(() => createItem(state, input), /不能超过|最多允许/);
  for (const title of ['无效\u0000标题', '两行\n标题', '\ud800']) assert.throws(() => createItem(state, { title }));
  assertValid(result);
});

test('local due dates reject impossible calendar days and timestamp validation rejects inconsistent histories', () => {
  const state = fixture();
  const id = state.items[0].id;
  assert.equal(applyCommand(state, { type: 'item.update', id, patch: { dueDate: '2028-02-29' } }, T2).items[0].dueDate, '2028-02-29');
  for (const dueDate of ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-1-1', '2026-10-19T00:00:00Z']) {
    assert.throws(() => applyCommand(state, { type: 'item.update', id, patch: { dueDate } }, T2));
  }
  for (const now of ['2026-02-30T08:00:00Z', '2026-10-19T25:00:00Z', '2026-10-19', 'yesterday', '2026-10-19T08:00:00+25:00']) assert.throws(() => createEmptyState(now));
  const changes: Array<Partial<Item>> = [
    { status: 'done', completedAt: null }, { status: 'open', completedAt: T1 },
    { kind: 'idea', status: 'doing' }, { createdAt: T2 }, { updatedAt: T0 },
    { deletedAt: T2 }, { status: 'done', completedAt: T0 },
  ];
  for (const change of changes) assert.throws(() => validateState({ ...state, items: [{ ...state.items[0], ...change }] }));
});

test('clock rollback cannot corrupt timestamp ordering and revisions remain serial-friendly', () => {
  let state = fixture();
  const id = state.items[0].id;
  state = applyCommand(state, { type: 'item.status', ids: [id], status: 'done' }, T3);
  const next = applyCommand(state, { type: 'item.update', id, patch: { title: '时钟调回后保存' } }, T0);
  assert.equal(next.updatedAt, T3);
  assert.equal(next.items[0].updatedAt, T3);
  assert.equal(next.items[0].completedAt, T3);
  assert.equal(next.revision, state.revision + 1);
  const exhausted = { ...next, revision: Number.MAX_SAFE_INTEGER };
  assert.throws(() => applyCommand(exhausted, { type: 'settings.update', patch: { theme: 'dark' } }, T4), /安全整数上限/);
  assert.equal(exhausted.settings.theme, 'system');
  assertValid(next);
});

test('merge preserves both independently edited projects and items and remaps subtasks', () => {
  const base = fixture();
  const p = base.projects[0].id;
  const id = base.items[0].id;
  let current = applyCommand(base, { type: 'project.update', id: p, patch: { name: '本地方案', color: '#f00' } }, T2);
  current = applyCommand(current, { type: 'item.update', id, patch: { title: '本地改稿', body: '电脑里的版本', pinned: true, subtasks: [{ id: 'subtask-one', text: '本地子任务', done: true }] } }, T3);
  let imported = applyCommand(base, { type: 'project.update', id: p, patch: { name: '备份方案', color: '#0f0' } }, T2);
  imported = applyCommand(imported, { type: 'item.update', id, patch: { title: '来自备份的改稿', body: '另一份独立修改', status: 'done', subtasks: [{ id: 'subtask-one', text: '导入子任务', done: false }] } }, T3);
  imported = applyCommand(imported, { type: 'settings.update', patch: { theme: 'dark', startOnLogin: true, quickShortcut: '' } }, T4);
  const originalCurrent = frozen(clone(current));
  const originalImport = frozen(clone(imported));
  const merged = mergeState(originalCurrent, originalImport, T5);
  assert.equal(merged.projects.length, 2);
  assert.equal(merged.items.length, 2);
  assert.equal(merged.revision, current.revision + 1);
  assert.deepEqual(merged.settings, current.settings);
  assert.deepEqual(merged.items.find(item => item.id === id), current.items[0]);
  const importedProject = merged.projects.find(project => project.name === '备份方案')!;
  const importedItem = merged.items.find(item => item.title === '来自备份的改稿')!;
  assert.notEqual(importedProject.id, p);
  assert.notEqual(importedItem.id, id);
  assert.equal(importedItem.projectId, importedProject.id);
  assert.equal(importedItem.body, imported.items[0].body);
  assert.equal(importedItem.completedAt, T3);
  assert.equal(importedItem.subtasks[0].text, '导入子任务');
  assert.notEqual(importedItem.subtasks[0].id, 'subtask-one');
  assert.deepEqual(originalCurrent, current);
  assert.deepEqual(originalImport, imported);
  assert.deepEqual(mergeState(merged, imported, T6), merged, 'same conflict backup must be idempotent');
  assertValid(merged);
});

test('reimport after editing an imported conflict copy keeps the edited copy and one original backup copy', () => {
  const base = fixture();
  const id = base.items[0].id;
  const current = applyCommand(base, { type: 'item.update', id, patch: { title: '本地改动' } }, T2);
  const incoming = applyCommand(base, { type: 'item.update', id, patch: { title: '备份改动' } }, T3);
  const first = mergeState(current, incoming, T4);
  const copyId = first.items.find(item => item.id !== id)!.id;
  const edited = applyCommand(first, { type: 'item.update', id: copyId, patch: { title: '继续编辑导入副本', subtasks: [{ id: first.items.find(item => item.id === copyId)!.subtasks[0].id, text: '副本的新子任务', done: true }] } }, T5);
  const merged = mergeState(edited, incoming, T6);
  assert.equal(merged.items.length, 3);
  assert.deepEqual(new Set(merged.items.map(item => item.title)), new Set(['本地改动', '继续编辑导入副本', '备份改动']));
  assert.equal(merged.items.find(item => item.id === copyId)!.subtasks[0].text, '副本的新子任务');
  assert.equal(new Set(merged.items.map(item => item.subtasks[0].id)).size, 3);
  assert.deepEqual(mergeState(merged, incoming, T6), merged);
  assertValid(merged);
});

test('reimport after editing a copied project preserves all versions and maps the restored project copy', () => {
  const base = fixture();
  const p = base.projects[0].id;
  const current = applyCommand(base, { type: 'project.update', id: p, patch: { name: '本地项目' } }, T2);
  const incoming = applyCommand(base, { type: 'project.update', id: p, patch: { name: '备份项目' } }, T3);
  const first = mergeState(current, incoming, T4);
  const importedProject = first.projects.find(project => project.name === '备份项目')!;
  const edited = applyCommand(first, { type: 'project.update', id: importedProject.id, patch: { name: '继续编辑项目副本' } }, T5);
  const merged = mergeState(edited, incoming, T6);
  assert.equal(merged.projects.length, 3);
  assert.equal(merged.items.length, 3);
  const restoredProject = merged.projects.find(project => project.name === '备份项目')!;
  assert.notEqual(restoredProject.id, importedProject.id);
  assert.ok(merged.items.some(item => item.projectId === restoredProject.id));
  assert.ok(merged.items.some(item => item.projectId === importedProject.id));
  assert.deepEqual(mergeState(merged, incoming, T6), merged);
  assertValid(merged);
});

test('a backup can recover deleted projects without replacing locally moved records or restoring trash silently', () => {
  const backup = fixture();
  const p = backup.projects[0].id;
  const id = backup.items[0].id;
  let current = applyCommand(backup, { type: 'item.delete', ids: [id] }, T2);
  current = applyCommand(current, { type: 'project.delete', id: p }, T3);
  const merged = mergeState(current, backup, T4);
  assert.equal(merged.projects.length, 1);
  assert.equal(merged.projects[0].id, p);
  assert.equal(merged.items.length, 2);
  const local = merged.items.find(item => item.id === id)!;
  assert.equal(local.projectId, null);
  assert.equal(local.deletedAt, T2);
  const recovered = merged.items.find(item => item.id !== id)!;
  assert.equal(recovered.projectId, p);
  assert.equal(recovered.deletedAt, null);
  assert.equal(recovered.body, backup.items[0].body);
  assert.deepEqual(mergeState(merged, backup, T5), merged);
  assertValid(merged);
});

test('duplicate imports and ordering-only differences do not create records or alter local preferences', () => {
  let current = fixture();
  current = createItem(current, { title: '第二条记录' }, T2);
  const imported = clone(current);
  imported.items[0].order = 500;
  imported.items[1].order = 0;
  imported.projects[0].order = 1_000;
  imported.settings.theme = 'dark';
  imported.settings.startOnLogin = true;
  imported.updatedAt = T4;
  imported.revision = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(mergeState(current, imported, T5), current);
  const empty = createEmptyState(T0);
  const first = mergeState(empty, imported, T1);
  assert.equal(first.revision, 1);
  assert.equal(first.updatedAt, T4, 'future imported clock sets a valid workspace upper bound');
  assert.deepEqual(first.settings, empty.settings);
  assert.deepEqual(first.items.map(item => item.title), ['第二条记录', '试着画一个小原型']);
  assert.deepEqual(mergeState(first, imported, T6), first);
  assert.notEqual(first.items[0].tags, imported.items[1].tags);
  assertValid(first);
});

test('merge never deduplicates independently created records merely because they share a title', () => {
  const current = createItem(createEmptyState(T0), { title: '同一个标题', body: '第一次记录' }, T1);
  const incoming = createItem(createEmptyState(T0), { title: '同一个标题', body: '第二次记录' }, T2);
  const merged = mergeState(current, incoming, T3);
  assert.equal(merged.items.length, 2);
  assert.deepEqual(new Set(merged.items.map(item => item.body)), new Set(['第一次记录', '第二次记录']));
  assert.deepEqual(mergeState(merged, incoming, T4), merged);
});

test('an imported ID that occupies another record\'s generated conflict ID cannot overwrite either record', () => {
  const base = fixture();
  const id = base.items[0].id;
  const current = applyCommand(base, { type: 'item.update', id, patch: { title: '本地记录' } }, T2);
  const incoming = applyCommand(base, { type: 'item.update', id, patch: { title: '备份里的修改' } }, T3);
  const probe = mergeState(current, incoming, T4);
  const generated = probe.items.find(item => item.id !== id)!.id;
  const withCollision = clone(incoming);
  withCollision.items.push({ ...clone(incoming.items[0]), id: generated, title: '另一个具有碰撞 ID 的独立记录', order: 1 });
  const merged = mergeState(current, withCollision, T4);
  assert.equal(merged.items.length, 3);
  assert.equal(new Set(merged.items.map(item => item.id)).size, 3);
  assert.deepEqual(new Set(merged.items.map(item => item.title)), new Set(['本地记录', '备份里的修改', '另一个具有碰撞 ID 的独立记录']));
  assert.deepEqual(mergeState(merged, withCollision, T5), merged);
  assertValid(merged);
});

test('large batch imports retain every record and assign stable append ordering', () => {
  const incoming = fixture();
  const template = incoming.items[0];
  incoming.items = Array.from({ length: 5_000 }, (_, index) => ({ ...clone(template), id: `bulk-item-${index}`, title: `批量记录 ${index}`, order: index }));
  const current = createItem(createEmptyState(T0), { title: '原来的一条' }, T1);
  const merged = mergeState(current, incoming, T2);
  assert.equal(merged.items.length, 5_001);
  assert.equal(merged.items[0].id, current.items[0].id);
  assert.equal(merged.items.at(-1)!.title, '批量记录 4999');
  assert.equal(merged.items.at(-1)!.order, 5_000);
  assert.deepEqual(mergeState(merged, incoming, T3), merged);
  assertValid(merged);
});

test('exhausted item and project numeric ranks compact without changing visible order or losing data', () => {
  const state = fixture();
  state.projects[0].order = Number.MAX_SAFE_INTEGER;
  state.items[0].order = Number.MAX_SAFE_INTEGER;
  let current = createItem(state, { title: '接着添加' }, T2);
  current = createProject(current, '下一组', T2);
  assert.deepEqual(current.items.map(item => item.order), [0, 1]);
  assert.deepEqual(current.projects.map(project => project.order), [0, 1]);
  assert.equal(current.items[0].title, state.items[0].title);
  assert.equal(current.items[0].updatedAt, T2);
  const incoming = createItem(createEmptyState(T0), { title: '导入的新记录' }, T3);
  const merged = mergeState(state, incoming, T4);
  assert.deepEqual(merged.items.map(item => item.order), [0, 1]);
  assert.equal(state.items[0].order, Number.MAX_SAFE_INTEGER);
  assertValid(current);
  assertValid(merged);
});

test('settings updates validate values, normalize accelerators, and keep unrelated data intact', () => {
  const state = fixture();
  const updated = applyCommand(state, { type: 'settings.update', patch: { theme: 'dark', view: 'board', closeToTray: false, alwaysOnTop: true, startOnLogin: true, onboardingComplete: true, quickShortcut: ' ctrl + alt + space ' } }, T2);
  assert.deepEqual(updated.settings, { theme: 'dark', view: 'board', closeToTray: false, alwaysOnTop: true, startOnLogin: true, onboardingComplete: true, quickShortcut: 'Control+Alt+Space' });
  assert.deepEqual(updated.items, state.items);
  assert.deepEqual(updated.projects, state.projects);
  const disabled = applyCommand(updated, { type: 'settings.update', patch: { quickShortcut: '' } }, T3);
  assert.equal(disabled.settings.quickShortcut, '');
  for (const quickShortcut of ['Ctrl+Ctrl+Space', 'CommandOrControl+', 'Ctrl++', 'Control+Banana', 'constructor+Space', 'Ctrl+Alt', 'A\nB']) assert.throws(() => applyCommand(state, { type: 'settings.update', patch: { quickShortcut } }, T2));
  assert.equal(applyCommand(state, { type: 'settings.update', patch: { quickShortcut: 'CmdOrCtrl+Shift+n' } }, T2).settings.quickShortcut, 'CommandOrControl+Shift+N');
  assertValid(updated);
});

test('demo workspace is explicit, fictional, reproducible, and refuses to overwrite any existing content', () => {
  const empty = applyCommand(createEmptyState(T0), { type: 'settings.update', patch: { theme: 'dark' } }, T0);
  const demo = applyCommand(empty, { type: 'demo.load' }, T1);
  assert.equal(demo.projects.length, 3);
  assert.equal(demo.items.length, 8);
  assert.ok(demo.items.every(item => item.tags.includes('示例')));
  assert.deepEqual(demo.settings, empty.settings);
  assert.equal(demo.revision, empty.revision + 1);
  assert.deepEqual(createDemoState(T1), createDemoState(T1));
  const projectOnly = createProject(createEmptyState(T0));
  const trashed = applyCommand(createItem(createEmptyState(T0)), { type: 'item.delete', ids: [createItem(createEmptyState(T0)).items[0].id] }, T2);
  for (const state of [demo, projectOnly, trashed]) {
    const before = clone(state);
    assert.throws(() => applyCommand(state, { type: 'demo.load' }, T3), /仅能在.*空工作区/);
    assert.deepEqual(state, before);
  }
  assertValid(demo);
});

test('localDate uses local calendar components across both sides of UTC and daylight-saving boundaries', { concurrency: false }, () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    assert.equal(localDate(new Date('2026-10-19T01:30:00Z')), '2026-10-18');
    process.env.TZ = 'Pacific/Kiritimati';
    assert.equal(localDate(new Date('2026-10-19T12:30:00Z')), '2026-10-20');
    process.env.TZ = 'America/New_York';
    assert.equal(localDate(new Date('2026-03-08T04:30:00Z')), '2026-03-07');
    assert.equal(localDate(new Date('2026-03-08T07:30:00Z')), '2026-03-08');
    assert.equal(localDate(new Date(2026, 9, 19, 0, 1)), '2026-10-19');
    const localOnly = new Date(2026, 9, 19);
    localOnly.toISOString = () => { throw new Error('UTC slicing is not permitted'); };
    assert.equal(localDate(localOnly), '2026-10-19');
    assert.throws(() => localDate(new Date('not-a-date')), /无效日期/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('Markdown includes projects, inbox, checklists, completion, tags and trash without raw note HTML', () => {
  let state = fixture();
  const id = state.items[0].id;
  state = applyCommand(state, { type: 'item.update', id, patch: { title: '标题 <script> & [链接]', body: '正文\n<script>alert("note")</script>', pinned: true, status: 'done', subtasks: [{ id: 's1', text: '已完成一步', done: true }, { id: 's2', text: '仍然保留的一步', done: false }] } }, T2);
  state = createItem(state, { title: '留在收件箱' }, T2);
  state = applyCommand(state, { type: 'item.delete', ids: [id] }, T3);
  const output = toMarkdown(state);
  assert.match(output, /^# 拾念 · 备忘与待办/m);
  assert.match(output, /^## 收件箱$/m);
  assert.match(output, /^## 小小实验室$/m);
  assert.match(output, /^## 回收站$/m);
  assert.ok(output.includes('留在收件箱'));
  assert.ok(output.includes('- [x] 已完成一步'));
  assert.ok(output.includes('- [ ] 仍然保留的一步'));
  assert.ok(output.includes('截止日期：2026-10-20'));
  assert.ok(output.includes('标签：#设计'));
  assert.ok(output.includes(`完成：${T2}`));
  assert.ok(output.includes(`移入回收站：${T3}`));
  assert.ok(output.includes('&lt;script&gt;'));
  assert.ok(!output.includes('<script>'));
  assert.ok(output.endsWith('\n'));
  assert.equal(toMarkdown(state), output);
  assert.match(toMarkdown(createEmptyState(T0)), /暂无记录/);
});
