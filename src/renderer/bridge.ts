import { applyCommand, createEmptyState, mergeState, toMarkdown, validateState } from '../shared/domain';
import type { AppState, Command, DesktopBridge } from '../shared/types';

declare global { interface Window { shinian?: DesktopBridge } }
const STORAGE_KEY = 'shinian.preview.state.v1';
function browserBridge(): DesktopBridge {
  const listeners = new Set<(state: AppState) => void>();
  let tail: Promise<unknown> = Promise.resolve();
  const read = () => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyState();
    try { return validateState(JSON.parse(raw)); }
    catch { throw new Error('预览数据无法读取。请先导出浏览器存储，避免覆盖原有内容。'); }
  };
  const publish = (state: AppState) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { throw new Error('浏览器空间不足，未保存本次更改。桌面版使用独立本地文件保存。'); }
    listeners.forEach(listener => { try { listener(state); } catch (error) { console.error('界面更新失败', error); } });
    return state;
  };
  const serialize = <T,>(fn: () => T | Promise<T>): Promise<T> => {
    const run = () => navigator.locks ? navigator.locks.request('shinian-preview-write', fn) : Promise.resolve(fn());
    const next = tail.then(run, run); tail = next.catch(() => {}); return next;
  };
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY) { try { const s = read(); listeners.forEach(l => { try { l(s); } catch (error) { console.error('界面更新失败', error); } }); } catch {} }
  });
  function download(text: string, extension: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = url;
    a.download = `拾念备份-${new Date().toLocaleDateString('sv-SE')}.${extension}`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return {
    getState: async () => read(),
    dispatch: command => serialize(() => publish(applyCommand(read(), command))),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getInfo: async () => ({ version: '1.0.0', platform: 'web', dataPath: '当前浏览器的本地存储', shortcutRegistered: false, mode: 'browser' }),
    exportData: async format => {
      const state = read();
      download(format === 'json' ? JSON.stringify(state, null, 2) : toMarkdown(state), format === 'json' ? 'json' : 'md', format === 'json' ? 'application/json' : 'text/markdown');
      return { canceled: false };
    },
    importData: () => new Promise((resolve, reject) => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
      input.oncancel = () => resolve({ canceled: true });
      input.onchange = async () => {
        try {
          if (!input.files?.[0]) return resolve({ canceled: true });
          if (input.files[0].size > 50 * 1024 * 1024) throw new Error('备份超过 50 MB，请使用桌面版导入。');
          const imported = validateState(JSON.parse(await input.files[0].text()));
          if (!window.confirm(`合并导入 ${imported.items.length} 条内容和 ${imported.projects.length} 个分类？已有内容会保留。`)) return resolve({ canceled: true });
          const state = await serialize(() => publish(mergeState(read(), imported)));
          resolve({ canceled: false, state });
        } catch (error) { reject(error); }
      };
      input.click();
    }),
    openDataFolder: async () => { throw new Error('桌面版可打开数据文件夹；当前是浏览器预览。'); },
    listBackups: async () => [],
    restoreBackup: async () => { throw new Error('自动备份恢复请在桌面版中使用。'); },
    openQuickCapture: async () => { window.open(`${location.pathname}?quick=1`, 'shinian-quick', 'width=600,height=460'); },
    windowAction: async action => { if (action === 'hide' || action === 'close') window.close(); },
  };
}
export function getBridge(): DesktopBridge {
  if (window.shinian) return window.shinian;
  if (location.protocol === 'http:' || location.protocol === 'https:') return browserBridge();
  throw new Error('桌面连接未能启动。请从完整解压后的 Shinian.exe 打开拾念，不要单独打开界面文件。');
}
