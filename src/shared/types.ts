export type ItemKind = 'idea' | 'todo';
export type ItemStatus = 'open' | 'doing' | 'done';
export type Priority = 'none' | 'low' | 'medium' | 'high';
export type Theme = 'light' | 'dark' | 'system';
export interface Subtask { id: string; text: string; done: boolean }
export interface Item {
  id: string; title: string; body: string; kind: ItemKind; status: ItemStatus;
  projectId: string | null; tags: string[]; priority: Priority; dueDate: string | null;
  pinned: boolean; subtasks: Subtask[]; order: number;
  createdAt: string; updatedAt: string; completedAt: string | null; deletedAt: string | null;
}
export interface Project {
  id: string; name: string; color: string; icon: string; order: number;
  createdAt: string;
}
export interface Settings {
  theme: Theme; view: 'cards' | 'list' | 'board';
  closeToTray: boolean; alwaysOnTop: boolean; quickShortcut: string;
  startOnLogin: boolean; onboardingComplete: boolean;
}
export interface AppState {
  schemaVersion: 1; revision: number; projects: Project[]; items: Item[];
  settings: Settings; updatedAt: string;
}
export type ItemInput = Partial<Pick<Item, 'title' | 'body' | 'kind' | 'status' | 'projectId' | 'tags' | 'priority' | 'dueDate' | 'pinned' | 'subtasks'>> & { title: string };
export type ItemPatch = Partial<Pick<Item, 'title' | 'body' | 'kind' | 'status' | 'projectId' | 'tags' | 'priority' | 'dueDate' | 'pinned' | 'subtasks'>>;
export type Command =
  | { type: 'item.create'; input: ItemInput }
  | { type: 'item.update'; id: string; patch: ItemPatch }
  | { type: 'item.move'; ids: string[]; projectId: string | null }
  | { type: 'item.status'; ids: string[]; status: ItemStatus; kind?: ItemKind }
  | { type: 'item.delete'; ids: string[] }
  | { type: 'item.restore'; ids: string[] }
  | { type: 'item.purge'; ids: string[] }
  | { type: 'item.reorder'; ids: string[] }
  | { type: 'project.create'; name: string; color: string; icon: string }
  | { type: 'project.update'; id: string; patch: Partial<Pick<Project, 'name' | 'color' | 'icon'>> }
  | { type: 'project.delete'; id: string }
  | { type: 'project.reorder'; ids: string[] }
  | { type: 'settings.update'; patch: Partial<Settings> }
  | { type: 'demo.load' };
export interface AppInfo {
  version: string; platform: string; dataPath: string;
  shortcutRegistered: boolean; storageWarning?: string; systemNotice?: string; mode: 'desktop' | 'browser';
}
export interface BackupInfo { id: string; createdAt: string; size: number }
export interface FileResult { canceled: boolean; path?: string; state?: AppState }
export interface DesktopBridge {
  getState(): Promise<AppState>;
  dispatch(command: Command): Promise<AppState>;
  subscribe(listener: (state: AppState) => void): () => void;
  getInfo(): Promise<AppInfo>;
  exportData(format: 'json' | 'markdown'): Promise<FileResult>;
  importData(): Promise<FileResult>;
  openDataFolder(): Promise<void>;
  listBackups(): Promise<BackupInfo[]>;
  restoreBackup(id: string): Promise<AppState | null>;
  openQuickCapture(): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close' | 'hide' | 'show-main'): Promise<void>;
}
export type SmartView = 'inbox' | 'all' | 'today' | 'todos' | 'pinned' | 'done' | 'trash';
export type ViewSelection = { type: 'smart'; key: SmartView } | { type: 'project'; id: string };
