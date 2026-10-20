import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyCommand, createEmptyState, mergeState, toMarkdown, validateState } from '../src/shared/domain';
import type { AppState, BackupInfo, Command } from '../src/shared/types';

export const MAX_DATA_BYTES = 64 * 1024 * 1024;
export const DATA_FILENAME = 'shinian.json';
export const RECOVERY_FILENAME = 'latest-good.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_PATTERN = /^auto-(\d{4}-\d{2}-\d{2})\.json$/;
const MANUAL_PATTERN = /^(before-import|before-restore|before-demo)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([a-f0-9-]{36})\.json$/;

export type StoreIO = Pick<typeof fs, 'mkdir' | 'readFile' | 'readdir' | 'stat' | 'lstat' | 'open' | 'rename' | 'unlink' | 'copyFile'>;

export interface StoreOptions {
  now?: () => Date;
  io?: StoreIO;
  retentionDays?: number;
}

export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(cause instanceof Error ? `${message}（${cause.message}）` : message);
    this.name = 'StorageError';
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serialise(state: AppState): string {
  const data = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(data, 'utf8') > MAX_DATA_BYTES) {
    throw new StorageError('数据超过 64 MB，未保存。请先导出并整理工作区');
  }
  return data;
}

/** A rename is the commit point. Errors after it are warnings, never false failures. */
export async function atomicWrite(filePath: string, contents: string | Buffer, io: StoreIO = fs): Promise<string | undefined> {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let committed = false;
  try {
    handle = await io.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await io.rename(temporary, filePath);
    committed = true;
    // Directory fsync makes the rename durable on filesystems that implement it.
    // Windows does not expose a supported directory fsync through Node.
    if (process.platform !== 'win32') {
      let directoryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        directoryHandle = await io.open(directory, 'r');
        await directoryHandle.sync();
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(errorCode(error) ?? '')) {
          return `文件已保存，但目录同步未完成：${detail(error)}`;
        }
      } finally {
        if (directoryHandle) {
          try { await directoryHandle.close(); } catch { /* The data file has already committed. */ }
        }
      }
    }
    return undefined;
  } catch (error) {
    throw new StorageError(`无法安全写入 ${path.basename(filePath)}；原有数据未被替换`, error);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* Keep the original write error. */ }
    }
    if (!committed) {
      try { await io.unlink(temporary); } catch { /* A leftover temporary file is never loaded as user data. */ }
    }
  }
}

function parseData(bytes: Buffer): AppState {
  if (bytes.byteLength > MAX_DATA_BYTES) throw new StorageError('文件超过 64 MB，无法读取');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch (error) {
    throw new StorageError('文件不是有效的 UTF-8 文本', error);
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new StorageError('JSON 文件已损坏或格式不正确', error); }
  return validateState(value);
}

function backupDate(id: string): string | undefined {
  const auto = AUTO_PATTERN.exec(id);
  if (auto) return `${auto[1]}T00:00:00.000Z`;
  const manual = MANUAL_PATTERN.exec(id);
  if (!manual) return undefined;
  return manual[2].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
}

function isBackupId(value: unknown): value is string {
  return typeof value === 'string' && value.length < 150 && !!backupDate(value) && Number.isFinite(Date.parse(backupDate(value)!));
}

type Candidate = { kind: 'missing'; filePath: string } | { kind: 'invalid'; filePath: string; reason: string } | { kind: 'valid'; filePath: string; state: AppState };

/**
 * One process owns this store; Electron enforces its single-instance lock.
 * Every command, import and restore runs on the same queue. Callers receive clones.
 * A failed write never advances the in-memory state or poisons following commands.
 */
export class StateStore {
  readonly dataDir: string;
  readonly dataPath: string;
  readonly recoveryPath: string;
  readonly backupsDir: string;
  readonly corruptDir: string;
  private readonly io: StoreIO;
  private readonly now: () => Date;
  private readonly retentionDays: number;
  private state: AppState | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private initialisation: Promise<void> | undefined;
  private readonly listeners = new Set<(state: AppState) => void>();
  private readonly warnings = new Map<string, string>();

  constructor(dataDir: string, options: StoreOptions = {}) {
    this.dataDir = path.resolve(dataDir);
    this.dataPath = path.join(this.dataDir, DATA_FILENAME);
    this.recoveryPath = path.join(this.dataDir, RECOVERY_FILENAME);
    this.backupsDir = path.join(this.dataDir, 'backups');
    this.corruptDir = path.join(this.dataDir, 'preserved-corrupt');
    this.io = options.io ?? fs;
    this.now = options.now ?? (() => new Date());
    this.retentionDays = options.retentionDays ?? 14;
    if (!Number.isInteger(this.retentionDays) || this.retentionDays < 1) throw new Error('retentionDays must be a positive integer');
  }

  get warning(): string | undefined {
    return this.warnings.size ? [...this.warnings.values()].join('\n') : undefined;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  initialise(): Promise<void> {
    if (!this.initialisation) {
      this.initialisation = this.enqueue(async () => {
        try { await this.load(); } catch (error) {
          const failure = new StorageError('无法打开拾念数据。现有文件已保留，不会创建空白工作区覆盖它们', error);
          this.warnings.set('fatal', failure.message);
          throw failure;
        }
      });
    }
    return this.initialisation;
  }

  /** US spelling is retained for convenient external consumers. */
  initialize(): Promise<void> { return this.initialise(); }

  private async readCandidate(filePath: string): Promise<Candidate> {
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try { stats = await this.io.lstat(filePath); } catch (error) {
      if (errorCode(error) === 'ENOENT') return { kind: 'missing', filePath };
      throw new StorageError(`无法读取 ${path.basename(filePath)}`, error);
    }
    if (!stats.isFile() || stats.isSymbolicLink()) throw new StorageError(`${path.basename(filePath)} 不是普通数据文件`);
    if (stats.size > MAX_DATA_BYTES) return { kind: 'invalid', filePath, reason: '文件超过 64 MB' };
    let bytes: Buffer;
    try { bytes = await this.io.readFile(filePath); } catch (error) { throw new StorageError(`无法读取 ${path.basename(filePath)}`, error); }
    try { return { kind: 'valid', filePath, state: parseData(bytes) }; } catch (error) {
      return { kind: 'invalid', filePath, reason: detail(error) };
    }
  }

  private async backupIds(): Promise<string[]> {
    const files = await this.io.readdir(this.backupsDir);
    return files.filter(isBackupId).sort().reverse();
  }

  private async preserveCorrupt(filePath: string): Promise<string> {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(this.corruptDir, `${stamp}-${randomUUID()}-${path.basename(filePath)}.corrupt`);
    try {
      await this.io.copyFile(filePath, destination, constants.COPYFILE_EXCL);
      const handle = await this.io.open(destination, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      if (process.platform !== 'win32') {
        let directory: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
          directory = await this.io.open(this.corruptDir, 'r');
          await directory.sync();
        } catch (error) {
          if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(errorCode(error) ?? '')) throw error;
        } finally { if (directory) await directory.close(); }
      }
    } catch (error) {
      throw new StorageError('无法保留损坏文件，因此已停止恢复；原文件未被替换', error);
    }
    return destination;
  }

  private async load(): Promise<void> {
    await this.io.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await this.io.mkdir(this.backupsDir, { recursive: true, mode: 0o700 });
    await this.io.mkdir(this.corruptDir, { recursive: true, mode: 0o700 });
    const primary = await this.readCandidate(this.dataPath);
    if (primary.kind === 'valid') {
      this.state = primary.state;
      const recovery = await this.readCandidate(this.recoveryPath);
      if (recovery.kind === 'invalid') {
        // Preserving corruption is mandatory. If this fails, initialization stays
        // blocked so a later command cannot overwrite the unpreserved bytes.
        await this.preserveCorrupt(this.recoveryPath);
        this.warnings.set('recovery', '恢复副本曾损坏，已保留原文件，并从有效主文件重建恢复副本。');
      }
      try {
        await this.write(this.recoveryPath, serialise(this.state));
        this.warnings.delete('latest');
      } catch (error) { this.warnings.set('latest', `当前数据可用，但恢复副本未能更新：${detail(error)}`); }
      await this.maintainBackups();
      return;
    }

    const ids = await this.backupIds();
    const candidates = [await this.readCandidate(this.recoveryPath)];
    for (const id of ids) candidates.push(await this.readCandidate(path.join(this.backupsDir, id)));
    const valid = candidates.filter((candidate): candidate is Extract<Candidate, { kind: 'valid' }> => candidate.kind === 'valid')
      .sort((a, b) => b.state.revision - a.state.revision || b.state.updatedAt.localeCompare(a.state.updatedAt));
    if (valid.length) {
      const invalid = [primary, ...candidates].filter((candidate): candidate is Extract<Candidate, { kind: 'invalid' }> => candidate.kind === 'invalid');
      for (const candidate of invalid) await this.preserveCorrupt(candidate.filePath);
      const recovered = valid[0];
      await this.write(this.dataPath, serialise(recovered.state));
      this.state = recovered.state;
      this.warnings.set('recovery', `主数据文件${primary.kind === 'missing' ? '缺失' : '损坏'}，已从 ${path.basename(recovered.filePath)} 恢复有效数据${invalid.length ? '。损坏的原文件已保存在 preserved-corrupt 文件夹' : ''}。请检查最近的记录。`);
      try { await this.write(this.recoveryPath, serialise(this.state)); } catch (error) {
        this.warnings.set('latest', `数据已恢复，但恢复副本未能更新：${detail(error)}`);
      }
      await this.maintainBackups();
      return;
    }

    const preserved = await this.io.readdir(this.corruptDir);
    const existing = primary.kind !== 'missing' || candidates.some(candidate => candidate.kind !== 'missing') || preserved.length > 0;
    if (existing) {
      const reasons = [primary, ...candidates].filter(candidate => candidate.kind === 'invalid').map(candidate => `${path.basename(candidate.filePath)}：${candidate.reason}`);
      throw new StorageError(`没有可验证的恢复副本。请保留此目录并从已导出的 JSON 恢复。${reasons.length ? `\n${reasons.join('\n')}` : ''}`);
    }
    const empty = createEmptyState(this.now().toISOString());
    await this.write(this.dataPath, serialise(empty));
    this.state = empty;
    try { await this.write(this.recoveryPath, serialise(empty)); } catch (error) {
      this.warnings.set('latest', `工作区已创建，但恢复副本未能创建：${detail(error)}`);
    }
    // The first automatic daily snapshot is made after the first saved command.
  }

  private async write(filePath: string, contents: string | Buffer): Promise<void> {
    const warning = await atomicWrite(filePath, contents, this.io);
    if (warning) this.warnings.set('sync', warning);
    else this.warnings.delete('sync');
  }

  private current(): AppState {
    if (!this.state) throw new StorageError('数据尚未成功打开，不能读取或修改');
    return this.state;
  }

  async getState(): Promise<AppState> {
    await this.initialise();
    return this.enqueue(async () => structuredClone(this.current()));
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Resolves once all currently accepted operations have completed or failed. */
  async flush(): Promise<void> { await this.queue; }

  async dispatch(command: Command): Promise<AppState> {
    await this.initialise();
    const isolatedCommand = structuredClone(command);
    return this.enqueue(async () => {
      const next = applyCommand(this.current(), isolatedCommand, this.now().toISOString());
      if (isolatedCommand.type === 'demo.load') await this.snapshot('before-demo');
      return this.commit(next);
    });
  }

  private async commit(next: AppState): Promise<AppState> {
    const current = this.current();
    if (next.revision === current.revision) return structuredClone(current);
    const contents = serialise(validateState(next));
    try {
      // Ensure the currently acknowledged state is recoverable before replacement.
      await this.write(this.recoveryPath, serialise(current));
      await this.write(this.dataPath, contents);
    } catch (error) {
      this.warnings.set('save', `本次修改未保存：${detail(error)}`);
      throw error;
    }
    this.state = next;
    this.warnings.delete('save');
    try {
      await this.write(this.recoveryPath, contents);
      this.warnings.delete('latest');
    } catch (error) { this.warnings.set('latest', `内容已保存，但最新恢复副本更新失败：${detail(error)}`); }
    await this.maintainBackups();
    for (const listener of this.listeners) {
      try { listener(structuredClone(next)); } catch (error) {
        // A closed window must not turn a successful disk commit into a failed save.
        console.error('Shinian state subscriber failed:', detail(error));
      }
    }
    return structuredClone(next);
  }

  private async snapshot(reason: 'before-import' | 'before-restore' | 'before-demo'): Promise<string> {
    const id = `${reason}-${this.now().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
    try { await this.write(path.join(this.backupsDir, id), serialise(this.current())); } catch (error) {
      throw new StorageError('操作前的安全备份失败，本次操作未执行', error);
    }
    return id;
  }

  private async maintainBackups(): Promise<void> {
    try {
      const day = this.now().toISOString().slice(0, 10); // Backup filenames use UTC; item due dates do not.
      const destination = path.join(this.backupsDir, `auto-${day}.json`);
      const existing = await this.readCandidate(destination);
      if (existing.kind === 'invalid') {
        await this.preserveCorrupt(destination);
        this.warnings.set('damaged-backup', '一个自动备份文件已损坏，原文件已保留；当前有效数据已重新备份。');
      }
      await this.write(destination, serialise(this.current()));
      const cutoff = this.now().getTime() - this.retentionDays * DAY_MS;
      for (const id of await this.backupIds()) {
        const timestamp = Date.parse(backupDate(id)!);
        if (timestamp >= cutoff) continue;
        const target = path.join(this.backupsDir, id);
        const stats = await this.io.lstat(target);
        // Never follow or delete a path outside the recognized regular backup files.
        if (stats.isFile() && !stats.isSymbolicLink()) await this.io.unlink(target);
      }
      this.warnings.delete('backups');
    } catch (error) { this.warnings.set('backups', `当前内容已保存，但自动备份或清理失败：${detail(error)}`); }
  }

  async readImport(filePath: string): Promise<AppState> {
    const candidate = await this.readCandidate(path.resolve(filePath));
    if (candidate.kind === 'missing') throw new StorageError('选择的 JSON 文件不存在');
    if (candidate.kind === 'invalid') throw new StorageError(`无法导入：${candidate.reason}`);
    return structuredClone(candidate.state);
  }

  async importState(imported: unknown): Promise<AppState> {
    const validated = validateState(imported);
    await this.initialise();
    return this.enqueue(async () => {
      const merged = mergeState(this.current(), validated, this.now().toISOString());
      // Validation and merge must succeed before any backup or data mutation.
      serialise(merged);
      await this.snapshot('before-import');
      return this.commit(merged);
    });
  }

  async listBackups(): Promise<BackupInfo[]> {
    // Available even when opening the primary data failed, for diagnosis.
    return this.enqueue(async () => {
      try {
        const backups: BackupInfo[] = [];
        for (const id of await this.backupIds()) {
          const stats = await this.io.lstat(path.join(this.backupsDir, id));
          if (!stats.isFile() || stats.isSymbolicLink()) continue;
          backups.push({ id, createdAt: stats.mtime.toISOString(), size: stats.size });
        }
        return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      } catch (error) { throw new StorageError('无法列出备份文件', error); }
    });
  }

  async readBackup(id: string): Promise<AppState> {
    if (!isBackupId(id)) throw new StorageError('备份标识无效');
    const candidate = await this.readCandidate(path.join(this.backupsDir, id));
    if (candidate.kind === 'missing') throw new StorageError('此备份已不存在，请刷新备份列表');
    if (candidate.kind === 'invalid') throw new StorageError(`此备份无法恢复：${candidate.reason}`);
    return structuredClone(candidate.state);
  }

  async restoreBackup(id: string, preparedSnapshot?: AppState): Promise<AppState> {
    if (!isBackupId(id)) throw new StorageError('备份标识无效');
    // Main may hold the validated selection while a native confirmation is open.
    // The daily snapshot can legitimately change in another window meanwhile.
    const prepared = preparedSnapshot ? validateState(preparedSnapshot) : undefined;
    await this.initialise();
    return this.enqueue(async () => {
      const restored = prepared ?? await this.readBackup(id);
      // A rolled-back system clock must not invalidate records from a future
      // timestamp that was previously acknowledged on this or another machine.
      const updatedAt = [this.now().toISOString(), this.current().updatedAt, restored.updatedAt].sort().at(-1)!;
      const next = validateState({ ...restored, revision: this.current().revision + 1, updatedAt });
      serialise(next);
      await this.snapshot('before-restore');
      return this.commit(next);
    });
  }

  async exportText(format: 'json' | 'markdown'): Promise<string> {
    if (format !== 'json' && format !== 'markdown') throw new StorageError('导出格式无效');
    const state = await this.getState();
    return format === 'json' ? serialise(state) : toMarkdown(state);
  }

  async exportFile(filePath: string, format: 'json' | 'markdown'): Promise<void> {
    const destination = path.resolve(filePath);
    const relative = path.relative(this.dataDir, destination);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new StorageError('请选择应用数据目录之外的导出位置，以免覆盖工作区或备份');
    }
    const contents = await this.exportText(format);
    const warning = await atomicWrite(destination, contents, this.io);
    if (warning) this.warnings.set('export-sync', warning);
  }
}
