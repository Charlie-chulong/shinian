import type { AppState, Command, Item, ItemInput, ItemKind, ItemPatch, ItemStatus, Priority, Project, Settings, Subtask } from './types';

// Keep these limits above normal writing needs. Invalid data is rejected, never
// truncated, so the caller can retain the draft and explain what needs changing.
const LIMITS = {
  projects: 10_000,
  items: 100_000,
  title: 1_000,
  body: 1_000_000,
  projectName: 200,
  icon: 24,
  tags: 64,
  tag: 80,
  subtasks: 1_000,
  subtask: 1_000,
  id: 128,
  shortcut: 100,
} as const;

const ITEM_FIELDS = ['id', 'title', 'body', 'kind', 'status', 'projectId', 'tags', 'priority', 'dueDate', 'pinned', 'subtasks', 'order', 'createdAt', 'updatedAt', 'completedAt', 'deletedAt'] as const;
const ITEM_EDIT_FIELDS = ['title', 'body', 'kind', 'status', 'projectId', 'tags', 'priority', 'dueDate', 'pinned', 'subtasks'] as const;
const PROJECT_FIELDS = ['id', 'name', 'color', 'icon', 'order', 'createdAt'] as const;
const PROJECT_EDIT_FIELDS = ['name', 'color', 'icon'] as const;
const SETTINGS_FIELDS = ['theme', 'view', 'closeToTray', 'alwaysOnTop', 'quickShortcut', 'startOnLogin', 'onboardingComplete'] as const;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

function fail(path: string, message: string): never {
  throw new Error(`${path}：${message}`);
}

function record(value: unknown, path: string, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是对象');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, '不接受带有自定义原型的对象');
  const names = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || !names.has(key)) fail(path, '包含不支持或不安全的字段');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !hasOwn(descriptor, 'value')) fail(path, '不接受访问器字段');
  }
  for (const key of required) if (!hasOwn(value, key)) fail(path, `缺少字段 ${key}`);
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(path, '必须是普通数组');
  if (value.length > maximum) fail(path, `最多允许 ${maximum} 项`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) fail(path, '数组包含不支持的字段');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !hasOwn(descriptor, 'value')) fail(path, '不接受数组访问器');
  }
  for (let index = 0; index < value.length; index += 1) if (!hasOwn(value, index)) fail(path, '数组不能包含空位');
  return value;
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function textValue(value: unknown, path: string, maximum: number, options: { multiline?: boolean; empty?: boolean; preserveWhitespace?: boolean } = {}): string {
  if (typeof value !== 'string') fail(path, '必须是文字');
  if (value.length > maximum) fail(path, `长度不能超过 ${maximum} 个字符`);
  if (!validUnicode(value)) fail(path, '包含无效的 Unicode 字符');
  let normalized = value.replace(/\r\n?/g, '\n').normalize('NFC');
  if (!options.preserveWhitespace) normalized = normalized.trim();
  if (normalized.length > maximum) fail(path, `长度不能超过 ${maximum} 个字符`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) fail(path, '包含不支持的控制字符');
  if (!options.multiline && /[\n\t\u2028\u2029]/u.test(normalized)) fail(path, '必须是单行文字');
  if (!options.empty && normalized.length === 0) fail(path, '不能为空');
  return normalized;
}

function idValue(value: unknown, path: string): string {
  const id = textValue(value, path, LIMITS.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || FORBIDDEN_KEYS.has(id)) fail(path, '标识只能使用字母、数字、下划线和短横线');
  return id;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, '必须是布尔值');
  return value;
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(path, '必须是非负安全整数');
  return value;
}

function enumValue<const T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(path, `仅支持 ${values.join(' / ')}`);
  return value as T;
}

function calendarParts(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function dateValue(value: unknown, path: string): string {
  const date = textValue(value, path, 10);
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parts || !calendarParts(Number(parts[1]), Number(parts[2]), Number(parts[3]))) fail(path, '必须是有效的本地日期 YYYY-MM-DD');
  return date;
}

function timestamp(value: unknown, path: string): string {
  const input = textValue(value, path, 40);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!parts || !calendarParts(Number(parts[1]), Number(parts[2]), Number(parts[3])) || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) fail(path, '必须是带时区的有效 ISO 时间');
  if (parts[8] !== 'Z' && (Number(parts[8].slice(1, 3)) > 23 || Number(parts[8].slice(4, 6)) > 59)) fail(path, '时间的时区偏移无效');
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime())) fail(path, '时间无效');
  const normalized = parsed.toISOString();
  if (!/^\d{4}-/.test(normalized) || normalized.startsWith('0000-')) fail(path, '时间必须位于公元 1 至 9999 年');
  return normalized;
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestamp(value, path);
}

function colorValue(value: unknown, path: string): string {
  const color = textValue(value, path, 7).toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) return `#${[...color.slice(1)].map(character => character + character).join('')}`;
  fail(path, '颜色必须是 #RGB 或 #RRGGBB');
}

const SHORTCUT_MODIFIERS: Readonly<Record<string, string>> = {
  commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
  command: 'Command', cmd: 'Command', control: 'Control', ctrl: 'Control',
  alt: 'Alt', option: 'Alt', altgr: 'AltGr', shift: 'Shift', super: 'Super', meta: 'Meta',
};
const SHORTCUT_KEYS: Readonly<Record<string, string>> = Object.fromEntries([
  'Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'VolumeUp', 'VolumeDown', 'VolumeMute',
  'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause', 'PrintScreen', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
].map(key => [key.toLowerCase(), key]));

function shortcutValue(value: unknown, path: string): string {
  const shortcut = textValue(value, path, LIMITS.shortcut, { empty: true });
  if (!shortcut) return '';
  const parts = shortcut.split('+').map(part => part.trim());
  if (parts.some(part => !part)) fail(path, '快捷键格式无效；加号键请写作 Plus');
  const keyInput = parts.pop()!;
  const modifiers: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    const modifier = hasOwn(SHORTCUT_MODIFIERS, key) ? SHORTCUT_MODIFIERS[key] : undefined;
    if (!modifier || modifiers.includes(modifier)) fail(path, '包含无效或重复的修饰键');
    modifiers.push(modifier);
  }
  const lowerKey = keyInput.toLowerCase();
  let key: string | undefined;
  if (/^[a-z0-9]$/i.test(keyInput) || /^f(?:[1-9]|1\d|2[0-4])$/i.test(keyInput)) key = keyInput.toUpperCase();
  else if (/^num[0-9]$/i.test(keyInput)) key = lowerKey;
  else if (/^[,./;\[\]\\'`=\-]$/.test(keyInput)) key = keyInput;
  else if (lowerKey === 'esc') key = 'Escape';
  else if (hasOwn(SHORTCUT_KEYS, lowerKey)) key = SHORTCUT_KEYS[lowerKey];
  if (!key) fail(path, '必须包含一个有效按键，例如 CommandOrControl+Alt+Space');
  return [...modifiers, key].join('+');
}

function tagsValue(value: unknown, path: string): string[] {
  const tags = array(value, path, LIMITS.tags).map((entry, index) => textValue(entry, `${path}[${index}]`, LIMITS.tag));
  return [...new Set(tags)];
}

function subtasksValue(value: unknown, path: string): Subtask[] {
  const seen = new Set<string>();
  return array(value, path, LIMITS.subtasks).map((entry, index) => {
    const label = `${path}[${index}]`;
    const subtask = record(entry, label, ['id', 'text', 'done']);
    const id = idValue(subtask.id, `${label}.id`);
    if (seen.has(id)) fail(path, '子任务标识不能重复');
    seen.add(id);
    return { id, text: textValue(subtask.text, `${label}.text`, LIMITS.subtask), done: booleanValue(subtask.done, `${label}.done`) };
  });
}

function itemPatch(value: unknown, path: string, requireTitle = false): ItemPatch {
  const raw = record(value, path, ITEM_EDIT_FIELDS, requireTitle ? ['title'] : []);
  const patch: ItemPatch = {};
  if (hasOwn(raw, 'title')) patch.title = textValue(raw.title, `${path}.title`, LIMITS.title);
  if (hasOwn(raw, 'body')) patch.body = textValue(raw.body, `${path}.body`, LIMITS.body, { multiline: true, empty: true, preserveWhitespace: true });
  if (hasOwn(raw, 'kind')) patch.kind = enumValue(raw.kind, ['idea', 'todo'], `${path}.kind`);
  if (hasOwn(raw, 'status')) patch.status = enumValue(raw.status, ['open', 'doing', 'done'], `${path}.status`);
  if (hasOwn(raw, 'projectId')) patch.projectId = raw.projectId === null ? null : idValue(raw.projectId, `${path}.projectId`);
  if (hasOwn(raw, 'tags')) patch.tags = tagsValue(raw.tags, `${path}.tags`);
  if (hasOwn(raw, 'priority')) patch.priority = enumValue(raw.priority, ['none', 'low', 'medium', 'high'], `${path}.priority`);
  if (hasOwn(raw, 'dueDate')) patch.dueDate = raw.dueDate === null ? null : dateValue(raw.dueDate, `${path}.dueDate`);
  if (hasOwn(raw, 'pinned')) patch.pinned = booleanValue(raw.pinned, `${path}.pinned`);
  if (hasOwn(raw, 'subtasks')) patch.subtasks = subtasksValue(raw.subtasks, `${path}.subtasks`);
  return patch;
}

function projectPatch(value: unknown, path: string, required: readonly string[] = []): Partial<Pick<Project, 'name' | 'color' | 'icon'>> {
  const raw = record(value, path, PROJECT_EDIT_FIELDS, required);
  const patch: Partial<Pick<Project, 'name' | 'color' | 'icon'>> = {};
  if (hasOwn(raw, 'name')) patch.name = textValue(raw.name, `${path}.name`, LIMITS.projectName);
  if (hasOwn(raw, 'color')) patch.color = colorValue(raw.color, `${path}.color`);
  if (hasOwn(raw, 'icon')) patch.icon = textValue(raw.icon, `${path}.icon`, LIMITS.icon);
  return patch;
}

function settingsValue(value: unknown, path: string, partial: true): Partial<Settings>;
function settingsValue(value: unknown, path: string, partial?: false): Settings;
function settingsValue(value: unknown, path: string, partial = false): Partial<Settings> {
  const raw = record(value, path, SETTINGS_FIELDS, partial ? [] : SETTINGS_FIELDS);
  const settings: Partial<Settings> = {};
  if (hasOwn(raw, 'theme')) settings.theme = enumValue(raw.theme, ['light', 'dark', 'system'], `${path}.theme`);
  if (hasOwn(raw, 'view')) settings.view = enumValue(raw.view, ['cards', 'list', 'board'], `${path}.view`);
  if (hasOwn(raw, 'closeToTray')) settings.closeToTray = booleanValue(raw.closeToTray, `${path}.closeToTray`);
  if (hasOwn(raw, 'alwaysOnTop')) settings.alwaysOnTop = booleanValue(raw.alwaysOnTop, `${path}.alwaysOnTop`);
  if (hasOwn(raw, 'quickShortcut')) settings.quickShortcut = shortcutValue(raw.quickShortcut, `${path}.quickShortcut`);
  if (hasOwn(raw, 'startOnLogin')) settings.startOnLogin = booleanValue(raw.startOnLogin, `${path}.startOnLogin`);
  if (hasOwn(raw, 'onboardingComplete')) settings.onboardingComplete = booleanValue(raw.onboardingComplete, `${path}.onboardingComplete`);
  return settings;
}

function idsValue(value: unknown, path: string, maximum: number = LIMITS.items, allowEmpty = false): string[] {
  const ids = array(value, path, maximum).map((entry, index) => idValue(entry, `${path}[${index}]`));
  if (!allowEmpty && ids.length === 0) fail(path, '请至少选择一项');
  if (new Set(ids).size !== ids.length) fail(path, '不能重复选择同一项');
  return ids;
}

function commandValue(value: unknown): Command {
  // Validate the outer descriptor before reading type, including accessor safety.
  const command = record(value, '操作', ['type', 'input', 'id', 'ids', 'patch', 'projectId', 'status', 'kind', 'name', 'color', 'icon'], ['type']);
  const type = command.type;
  switch (type) {
    case 'item.create': {
      record(command, '创建记录', ['type', 'input']);
      return { type, input: itemPatch(command.input, '记录', true) as ItemInput };
    }
    case 'item.update': {
      record(command, '编辑记录', ['type', 'id', 'patch']);
      return { type, id: idValue(command.id, '记录标识'), patch: itemPatch(command.patch, '记录修改') };
    }
    case 'item.move': {
      record(command, '移动记录', ['type', 'ids', 'projectId']);
      return { type, ids: idsValue(command.ids, '记录标识'), projectId: command.projectId === null ? null : idValue(command.projectId, '项目标识') };
    }
    case 'item.status': {
      record(command, '修改状态', ['type', 'ids', 'status', 'kind'], ['type', 'ids', 'status']);
      const result: Extract<Command, { type: 'item.status' }> = { type, ids: idsValue(command.ids, '记录标识'), status: enumValue(command.status, ['open', 'doing', 'done'], '状态') };
      if (hasOwn(command, 'kind')) result.kind = enumValue(command.kind, ['idea', 'todo'], '记录类型');
      return result;
    }
    case 'item.delete':
    case 'item.restore':
    case 'item.purge':
    case 'item.reorder': {
      record(command, '记录操作', ['type', 'ids']);
      return { type, ids: idsValue(command.ids, '记录标识', LIMITS.items, type === 'item.reorder') };
    }
    case 'project.create': {
      record(command, '创建项目', ['type', 'name', 'color', 'icon']);
      return { type, name: textValue(command.name, '项目名称', LIMITS.projectName), color: colorValue(command.color, '项目颜色'), icon: textValue(command.icon, '项目图标', LIMITS.icon) };
    }
    case 'project.update': {
      record(command, '编辑项目', ['type', 'id', 'patch']);
      return { type, id: idValue(command.id, '项目标识'), patch: projectPatch(command.patch, '项目修改') };
    }
    case 'project.delete': {
      record(command, '删除项目', ['type', 'id']);
      return { type, id: idValue(command.id, '项目标识') };
    }
    case 'project.reorder': {
      record(command, '项目排序', ['type', 'ids']);
      return { type, ids: idsValue(command.ids, '项目标识', LIMITS.projects, true) };
    }
    case 'settings.update': {
      record(command, '修改设置', ['type', 'patch']);
      return { type, patch: settingsValue(command.patch, '设置', true) };
    }
    case 'demo.load': {
      record(command, '载入示例', ['type']);
      return { type };
    }
    default:
      fail('操作', '不支持的操作类型');
  }
}

/** Return the calendar day in the computer's local timezone, without UTC slicing. */
export function localDate(date: Date = new Date()): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('日期', '无效日期');
  const year = date.getFullYear();
  if (year < 1 || year > 9999) fail('日期', '日期必须位于公元 1 至 9999 年');
  return `${String(year).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function createEmptyState(now?: string): AppState {
  return {
    schemaVersion: 1,
    revision: 0,
    projects: [],
    items: [],
    settings: { theme: 'system', view: 'cards', closeToTray: true, alwaysOnTop: false, quickShortcut: 'CommandOrControl+Alt+Space', startOnLogin: false, onboardingComplete: false },
    updatedAt: timestamp(now ?? new Date().toISOString(), '当前时间'),
  };
}

/** Validate and reconstruct every object, severing aliases to caller-owned data. */
export function validateState(value: unknown): AppState {
  const raw = record(value, '工作区', ['schemaVersion', 'revision', 'projects', 'items', 'settings', 'updatedAt']);
  if (raw.schemaVersion !== 1) fail('工作区版本', '不支持此数据版本；目前仅支持 schemaVersion 1');
  const updatedAt = timestamp(raw.updatedAt, '工作区更新时间');
  const projectIds = new Set<string>();
  const projects = array(raw.projects, '项目', LIMITS.projects).map((entry, index): Project => {
    const path = `项目[${index}]`;
    const project = record(entry, path, PROJECT_FIELDS);
    const id = idValue(project.id, `${path}.id`);
    if (projectIds.has(id)) fail(path, '项目标识重复');
    projectIds.add(id);
    const createdAt = timestamp(project.createdAt, `${path}.createdAt`);
    if (createdAt > updatedAt) fail(path, '创建时间晚于工作区更新时间');
    return {
      id, name: textValue(project.name, `${path}.name`, LIMITS.projectName), color: colorValue(project.color, `${path}.color`),
      icon: textValue(project.icon, `${path}.icon`, LIMITS.icon), order: integerValue(project.order, `${path}.order`), createdAt,
    };
  });
  const itemIds = new Set<string>();
  const items = array(raw.items, '记录', LIMITS.items).map((entry, index): Item => {
    const path = `记录[${index}]`;
    const item = record(entry, path, ITEM_FIELDS);
    const id = idValue(item.id, `${path}.id`);
    if (itemIds.has(id)) fail(path, '记录标识重复');
    itemIds.add(id);
    const kind = enumValue(item.kind, ['idea', 'todo'], `${path}.kind`);
    const status = enumValue(item.status, ['open', 'doing', 'done'], `${path}.status`);
    if (kind === 'idea' && status === 'doing') fail(path, '进行中的记录必须是待办');
    const projectId = item.projectId === null ? null : idValue(item.projectId, `${path}.projectId`);
    if (projectId !== null && !projectIds.has(projectId)) fail(path, '引用的项目不存在');
    const createdAt = timestamp(item.createdAt, `${path}.createdAt`);
    const itemUpdatedAt = timestamp(item.updatedAt, `${path}.updatedAt`);
    const completedAt = nullableTimestamp(item.completedAt, `${path}.completedAt`);
    const deletedAt = nullableTimestamp(item.deletedAt, `${path}.deletedAt`);
    if (itemUpdatedAt < createdAt || itemUpdatedAt > updatedAt) fail(path, '创建、修改与工作区更新时间的顺序不一致');
    if ((status === 'done') !== (completedAt !== null)) fail(path, '完成状态与完成时间不一致');
    if (completedAt !== null && (completedAt < createdAt || completedAt > itemUpdatedAt)) fail(path, '完成时间超出记录的有效时间范围');
    if (deletedAt !== null && (deletedAt < createdAt || deletedAt > itemUpdatedAt)) fail(path, '删除时间超出记录的有效时间范围');
    return {
      id, title: textValue(item.title, `${path}.title`, LIMITS.title),
      body: textValue(item.body, `${path}.body`, LIMITS.body, { multiline: true, empty: true, preserveWhitespace: true }),
      kind, status, projectId, tags: tagsValue(item.tags, `${path}.tags`), priority: enumValue(item.priority, ['none', 'low', 'medium', 'high'], `${path}.priority`),
      dueDate: item.dueDate === null ? null : dateValue(item.dueDate, `${path}.dueDate`), pinned: booleanValue(item.pinned, `${path}.pinned`),
      subtasks: subtasksValue(item.subtasks, `${path}.subtasks`), order: integerValue(item.order, `${path}.order`),
      createdAt, updatedAt: itemUpdatedAt, completedAt, deletedAt,
    };
  });
  return { schemaVersion: 1, revision: integerValue(raw.revision, '工作区修订号'), projects, items, settings: settingsValue(raw.settings, '设置'), updatedAt };
}

function operationTime(now: string | undefined, ...states: AppState[]): string {
  let result = timestamp(now ?? new Date().toISOString(), '当前时间');
  // Wall clocks can move backwards. Revisions serialize writes; timestamps must
  // also remain valid when a backup or another computer has a later clock.
  for (const state of states) if (state.updatedAt > result) result = state.updatedAt;
  return result;
}

function nextRevision(revision: number): number {
  if (revision === Number.MAX_SAFE_INTEGER) fail('工作区修订号', '已达到安全整数上限，无法继续写入');
  return revision + 1;
}

function compareOrder(a: { order: number; id: string }, b: { order: number; id: string }): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function appendOrder<T extends { id: string; order: number }>(records: T[], changed?: (record: T) => void): number {
  let maximum = -1;
  for (const entry of records) maximum = Math.max(maximum, entry.order);
  if (maximum < Number.MAX_SAFE_INTEGER) return maximum + 1;
  // Compact only exhausted numeric ranks, preserving the visible ordering.
  [...records].sort(compareOrder).forEach((entry, index) => {
    if (entry.order !== index) { entry.order = index; changed?.(entry); }
  });
  return records.length;
}

// Deterministic non-secret fingerprints keep injected-time commands reproducible.
// Every generated ID is collision-checked; merge additionally compares contents.
function fingerprint(value: unknown): string {
  const input = JSON.stringify(value);
  let a = 0x811c9dc5, b = 0x9e3779b9, c = 0x85ebca6b, d = 0xc2b2ae35;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
    c = Math.imul(c ^ code, 0x27d4eb2d);
    d = Math.imul(d ^ code, 0x165667b1);
  }
  return [a, b, c, d].map(part => (part >>> 0).toString(16).padStart(8, '0')).join('');
}

function unusedId(base: string, used: ReadonlySet<string>): string {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) candidate = `${base}-${++suffix}`;
  return candidate;
}

function remapSubtasks(itemId: string, subtasks: Subtask[]): Subtask[] {
  const used = new Set<string>();
  return subtasks.map((subtask, index) => {
    const id = unusedId(`merge-subtask-${fingerprint([itemId, subtask.id, index])}`, used);
    used.add(id);
    return { ...subtask, id };
  });
}

function requireProject(state: AppState, id: string | null): void {
  if (id !== null && !state.projects.some(project => project.id === id)) fail('项目', '项目已不存在，请重新选择');
}

function selectedItems(state: AppState, ids: string[], activeOnly = false): Item[] {
  const byId = new Map(state.items.map(item => [item.id, item]));
  return ids.map(id => {
    const item = byId.get(id);
    if (!item) fail('记录', '部分记录已不存在，请刷新后重试');
    if (activeOnly && item.deletedAt !== null) fail('记录', '请先从回收站恢复记录，再进行编辑');
    return item;
  });
}

function applyItemPatch(item: Item, patch: ItemPatch, now: string): void {
  const before = JSON.stringify(item);
  const wasDone = item.status === 'done';
  Object.assign(item, patch);
  // An explicit conversion to idea has a defined destination. Moving to doing
  // without an explicit kind is the convenient inverse: turn the idea into todo.
  if (patch.kind === 'idea') item.status = patch.status === 'done' ? 'done' : 'open';
  else if (item.status === 'doing' && item.kind === 'idea') item.kind = 'todo';
  item.completedAt = item.status === 'done' ? (wasDone ? item.completedAt : now) : null;
  if (JSON.stringify(item) !== before) item.updatedAt = now;
}

function reorder<T extends { id: string; order: number }>(records: T[], ids: string[], changed?: (record: T) => void): T[] {
  const byId = new Map(records.map(entry => [entry.id, entry]));
  for (const id of ids) if (!byId.has(id)) fail('排序', '部分记录已不存在，请刷新后重试');
  if (ids.length === 0) return records;
  const selected = new Set(ids);
  const sorted = [...records].sort(compareOrder);
  let position = 0;
  // Reorder the selected slots, so sorting a filtered view does not pull hidden
  // records or other projects to the front of the workspace.
  const result = sorted.map(entry => selected.has(entry.id) ? byId.get(ids[position++])! : entry);
  result.forEach((entry, index) => {
    if (entry.order !== index) { entry.order = index; changed?.(entry); }
  });
  return result;
}

export function applyCommand(state: AppState, command: Command, now?: string): AppState {
  const next = validateState(state);
  const action = commandValue(command);
  const time = operationTime(now, next);
  const revision = nextRevision(next.revision);
  switch (action.type) {
    case 'item.create': {
      if (next.items.length >= LIMITS.items) fail('记录', `最多允许 ${LIMITS.items} 项`);
      requireProject(next, action.input.projectId ?? null);
      const kind = action.input.kind ?? (action.input.status === 'doing' ? 'todo' : 'idea');
      const status = kind === 'idea' && action.input.status !== 'done' ? 'open' : action.input.status ?? 'open';
      const id = unusedId(`item-${fingerprint([time, revision, action.input])}`, new Set(next.items.map(item => item.id)));
      next.items.push({
        id, title: action.input.title, body: action.input.body ?? '', kind, status,
        projectId: action.input.projectId ?? null, tags: action.input.tags ?? [], priority: action.input.priority ?? 'none',
        dueDate: action.input.dueDate ?? null, pinned: action.input.pinned ?? false, subtasks: action.input.subtasks ?? [],
        order: appendOrder(next.items, item => { item.updatedAt = time; }),
        createdAt: time, updatedAt: time, completedAt: status === 'done' ? time : null, deletedAt: null,
      });
      break;
    }
    case 'item.update': {
      const [item] = selectedItems(next, [action.id], true);
      if (hasOwn(action.patch, 'projectId')) requireProject(next, action.patch.projectId!);
      applyItemPatch(item, action.patch, time);
      break;
    }
    case 'item.move': {
      requireProject(next, action.projectId);
      for (const item of selectedItems(next, action.ids)) if (item.projectId !== action.projectId) { item.projectId = action.projectId; item.updatedAt = time; }
      break;
    }
    case 'item.status': {
      const patch: ItemPatch = { status: action.status };
      if (action.kind !== undefined) patch.kind = action.kind;
      for (const item of selectedItems(next, action.ids, true)) applyItemPatch(item, patch, time);
      break;
    }
    case 'item.delete': {
      for (const item of selectedItems(next, action.ids)) if (item.deletedAt === null) { item.deletedAt = time; item.updatedAt = time; }
      break;
    }
    case 'item.restore': {
      for (const item of selectedItems(next, action.ids)) if (item.deletedAt !== null) { item.deletedAt = null; item.updatedAt = time; }
      break;
    }
    case 'item.purge': {
      const selected = selectedItems(next, action.ids);
      if (selected.some(item => item.deletedAt === null)) fail('永久删除', '只能永久删除回收站中的记录');
      const ids = new Set(action.ids);
      next.items = next.items.filter(item => !ids.has(item.id));
      break;
    }
    case 'item.reorder': {
      selectedItems(next, action.ids, true);
      next.items = reorder(next.items, action.ids, item => { item.updatedAt = time; });
      break;
    }
    case 'project.create': {
      if (next.projects.length >= LIMITS.projects) fail('项目', `最多允许 ${LIMITS.projects} 项`);
      const id = unusedId(`project-${fingerprint([time, revision, action.name, action.color, action.icon])}`, new Set(next.projects.map(project => project.id)));
      next.projects.push({ id, name: action.name, color: action.color, icon: action.icon, order: appendOrder(next.projects), createdAt: time });
      break;
    }
    case 'project.update': {
      const project = next.projects.find(project => project.id === action.id);
      if (!project) fail('项目', '项目已不存在，请刷新后重试');
      Object.assign(project, action.patch);
      break;
    }
    case 'project.delete': {
      requireProject(next, action.id);
      next.projects = next.projects.filter(project => project.id !== action.id);
      for (const item of next.items) if (item.projectId === action.id) { item.projectId = null; item.updatedAt = time; }
      break;
    }
    case 'project.reorder': {
      next.projects = reorder(next.projects, action.ids);
      break;
    }
    case 'settings.update': {
      Object.assign(next.settings, action.patch);
      break;
    }
    case 'demo.load': {
      if (next.projects.length !== 0 || next.items.length !== 0) fail('示例工作区', '仅能在没有项目和记录的空工作区中载入，现有内容已保留');
      const demo = createDemoState(time);
      next.projects = demo.projects;
      next.items = demo.items;
      break;
    }
  }
  next.revision = revision;
  next.updatedAt = time;
  return next;
}

function projectContent(project: Project): unknown {
  return { name: project.name, color: project.color, icon: project.icon, createdAt: project.createdAt };
}

function itemContent(item: Item): unknown {
  return {
    title: item.title, body: item.body, kind: item.kind, status: item.status, projectId: item.projectId,
    tags: item.tags, priority: item.priority, dueDate: item.dueDate, pinned: item.pinned, subtasks: item.subtasks,
    createdAt: item.createdAt, updatedAt: item.updatedAt, completedAt: item.completedAt, deletedAt: item.deletedAt,
  };
}

function sameProject(a: Project, b: Project): boolean { return JSON.stringify(projectContent(a)) === JSON.stringify(projectContent(b)); }
function sameItem(a: Item, b: Item): boolean { return JSON.stringify(itemContent(a)) === JSON.stringify(itemContent(b)); }

/**
 * Merge data without deleting or overwriting a local record. A same-ID content
 * conflict creates an incoming copy; its deterministic ID makes repeat imports
 * idempotent. Collision suffixes preserve even a previously edited import copy.
 * Local device settings and visible local ordering stay under the user's control.
 */
export function mergeState(current: AppState, imported: unknown, now?: string): AppState {
  const next = validateState(current);
  const source = validateState(imported);
  const time = operationTime(now, next, source);
  const projects = new Map(next.projects.map(project => [project.id, project]));
  const items = new Map(next.items.map(item => [item.id, item]));
  const projectMapping = new Map<string, string>();
  let changed = false;
  let nextProjectOrder: number | undefined;
  let nextItemOrder: number | undefined;

  for (const incoming of [...source.projects].sort(compareOrder)) {
    let candidate = { ...incoming };
    const existing = projects.get(incoming.id);
    if (existing && !sameProject(existing, incoming)) {
      const base = `merge-project-${fingerprint([incoming.id, projectContent(incoming)])}`;
      let suffix = 1;
      candidate.id = base;
      while (projects.has(candidate.id) && !sameProject(projects.get(candidate.id)!, candidate)) candidate.id = `${base}-${++suffix}`;
    }
    projectMapping.set(incoming.id, candidate.id);
    if (!projects.has(candidate.id)) {
      if (next.projects.length >= LIMITS.projects) fail('导入项目', `合并后超过 ${LIMITS.projects} 项，未写入任何修改`);
      if (nextProjectOrder === undefined || nextProjectOrder > Number.MAX_SAFE_INTEGER) nextProjectOrder = appendOrder(next.projects);
      candidate.order = nextProjectOrder++;
      next.projects.push(candidate);
      projects.set(candidate.id, candidate);
      changed = true;
    }
  }

  for (const incoming of [...source.items].sort(compareOrder)) {
    const projected: Item = { ...incoming, projectId: incoming.projectId === null ? null : projectMapping.get(incoming.projectId)! };
    let candidate = projected;
    const existing = items.get(incoming.id);
    if (existing && !sameItem(existing, projected)) {
      const base = `merge-item-${fingerprint([incoming.id, itemContent(projected)])}`;
      let suffix = 1;
      while (true) {
        const id = suffix === 1 ? base : `${base}-${suffix}`;
        candidate = {
          ...projected, id,
          subtasks: remapSubtasks(id, projected.subtasks),
        };
        const prior = items.get(id);
        if (!prior || sameItem(prior, candidate)) break;
        suffix += 1;
      }
    }
    if (!items.has(candidate.id)) {
      if (next.items.length >= LIMITS.items) fail('导入记录', `合并后超过 ${LIMITS.items} 项，未写入任何修改`);
      if (nextItemOrder === undefined || nextItemOrder > Number.MAX_SAFE_INTEGER) nextItemOrder = appendOrder(next.items, item => { item.updatedAt = time; });
      candidate.order = nextItemOrder++;
      next.items.push(candidate);
      items.set(candidate.id, candidate);
      changed = true;
    }
  }

  if (!changed) return next;
  next.revision = nextRevision(next.revision);
  next.updatedAt = time;
  return next;
}

export function createDemoState(now?: string): AppState {
  const state = createEmptyState(now);
  const time = state.updatedAt;
  const day = new Date(time);
  const today = localDate(day);
  day.setDate(day.getDate() + 1);
  const tomorrow = localDate(day);
  state.projects = [
    { id: 'demo-project-lab', name: '产品实验室', color: '#8b5cf6', icon: '◈', order: 0, createdAt: time },
    { id: 'demo-project-life', name: '生活提案', color: '#14b8a6', icon: '☀', order: 1, createdAt: time },
    { id: 'demo-project-learning', name: '学习计划', color: '#f59e0b', icon: '✦', order: 2, createdAt: time },
  ];
  const examples: Array<{ id: string } & ItemInput> = [
    { id: 'demo-item-welcome', title: '让灵感在一处汇合', body: '这是一条示例想法。\n想到什么就先记下来，再慢慢为它找到位置。试着编辑内容、添加标签，或把卡片拖到左侧项目。', pinned: true, tags: ['示例', '灵感'] },
    { id: 'demo-item-prototype', title: '做一个五分钟的原型', body: '挑一个最小的想法，用纸笔画出它的第一步。\n只需要足够清楚，能够和别人聊起来。', kind: 'todo', status: 'doing', projectId: 'demo-project-lab', priority: 'high', dueDate: tomorrow, tags: ['示例', '设计'], subtasks: [{ id: 'demo-subtask-purpose', text: '写下一句话目标', done: true }, { id: 'demo-subtask-sketch', text: '画出三个关键画面', done: false }, { id: 'demo-subtask-question', text: '留一个想验证的问题', done: false }] },
    { id: 'demo-item-name', title: '给新点子留一个名字', body: '名字不必一次想好。先收集几个关键词：轻巧、好用、有一点惊喜。', projectId: 'demo-project-lab', pinned: true, tags: ['示例', '创意'] },
    { id: 'demo-item-walk', title: '周末散步路线', body: '找一条不赶时间的路线：从公园入口出发，经过水边，再绕到安静的小街。', projectId: 'demo-project-life', tags: ['示例', '日常'] },
    { id: 'demo-item-desk', title: '整理桌边的一小块空间', body: '从一小块开始，给常用的东西留出固定位置。', kind: 'todo', projectId: 'demo-project-life', priority: 'low', dueDate: today, tags: ['示例'], subtasks: [{ id: 'demo-subtask-clear', text: '移走暂时不用的物品', done: false }, { id: 'demo-subtask-place', text: '留一处放随手笔记', done: false }] },
    { id: 'demo-item-reading', title: '读完一篇设计短文', body: '读完后记下一个新观点，以及一个愿意尝试的小行动。', kind: 'todo', projectId: 'demo-project-learning', priority: 'medium', tags: ['示例', '阅读'] },
    { id: 'demo-item-next', title: '把随手记录变成下一步', body: '回看一条想法，问自己：如果今天只能推进一点点，可以做什么？', projectId: 'demo-project-learning', tags: ['示例', '方法'] },
    { id: 'demo-item-finished', title: '试着完成第一张卡片', body: '完成的记录会保留在这里，也可以随时重新打开。', kind: 'todo', status: 'done', tags: ['示例'] },
  ];
  state.items = examples.map((example, order): Item => ({
    id: example.id, title: example.title, body: example.body ?? '', kind: example.kind ?? 'idea', status: example.status ?? 'open',
    projectId: example.projectId ?? null, tags: example.tags ?? [], priority: example.priority ?? 'none', dueDate: example.dueDate ?? null,
    pinned: example.pinned ?? false, subtasks: example.subtasks ?? [], order, createdAt: time, updatedAt: time,
    completedAt: example.status === 'done' ? time : null, deletedAt: null,
  }));
  return validateState(state);
}

function markdownInline(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/[\\`*_{}\[\]()#+\-.!|<>]/g, character => `\\${character}`);
}

function markdownBody(value: string): string {
  // Retain the author's Markdown while rendering HTML as literal note content.
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function toMarkdown(state: AppState): string {
  const workspace = validateState(state);
  const lines = ['# 拾念 · 备忘与待办', '', `工作区最后更新：${workspace.updatedAt}`, '', `项目：${workspace.projects.length} · 记录：${workspace.items.length}`, ''];
  const priorityNames: Record<Priority, string> = { none: '无', low: '低', medium: '中', high: '高' };
  const statusNames: Record<ItemStatus, string> = { open: '未完成', doing: '进行中', done: '已完成' };
  const kindNames: Record<ItemKind, string> = { idea: '想法', todo: '待办' };
  const projectNames = new Map(workspace.projects.map(project => [project.id, project.name]));
  const activeGroups = new Map<string | null, Item[]>();
  const trash: Item[] = [];
  for (const item of workspace.items) {
    if (item.deletedAt !== null) trash.push(item);
    else {
      const group = activeGroups.get(item.projectId) ?? [];
      group.push(item);
      activeGroups.set(item.projectId, group);
    }
  }
  function writeItem(item: Item, includeProject = false): void {
    lines.push(`### ${item.status === 'done' ? '☑' : item.kind === 'todo' ? '☐' : '✦'} ${markdownInline(item.title)}`, '');
    const metadata = [kindNames[item.kind], statusNames[item.status], `优先级：${priorityNames[item.priority]}`];
    if (item.pinned) metadata.push('置顶');
    if (item.dueDate) metadata.push(`截止日期：${item.dueDate}`);
    if (includeProject) metadata.push(`项目：${markdownInline(item.projectId === null ? '收件箱' : projectNames.get(item.projectId)!)}`);
    lines.push(metadata.join(' · '), '');
    if (item.tags.length) lines.push(`标签：${item.tags.map(tag => `#${markdownInline(tag)}`).join(' ')}`, '');
    if (item.body) lines.push(markdownBody(item.body), '');
    if (item.subtasks.length) lines.push(...item.subtasks.map(subtask => `- [${subtask.done ? 'x' : ' '}] ${markdownInline(subtask.text)}`), '');
    lines.push(`创建：${item.createdAt} · 修改：${item.updatedAt}`);
    if (item.completedAt) lines.push(`完成：${item.completedAt}`);
    if (item.deletedAt) lines.push(`移入回收站：${item.deletedAt}`);
    lines.push(`记录标识：\`${item.id}\``, '');
  }
  function writeGroup(title: string, items: Item[], project?: Project): void {
    lines.push(`## ${markdownInline(title)}`, '');
    if (project) lines.push(`项目颜色：${project.color} · 图标：${markdownInline(project.icon)}`, '');
    if (!items.length) lines.push('_暂无记录。_', '');
    for (const item of [...items].sort(compareOrder)) writeItem(item);
  }
  writeGroup('收件箱', activeGroups.get(null) ?? []);
  for (const project of [...workspace.projects].sort(compareOrder)) writeGroup(project.name, activeGroups.get(project.id) ?? [], project);
  if (trash.length) {
    lines.push('## 回收站', '');
    for (const item of trash.sort(compareOrder)) writeItem(item, true);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
