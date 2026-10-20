import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, DesktopBridge } from '../src/shared/types';
import { CHANNELS } from './channels';

// Each capability has its own fixed channel. Neither the IPC event nor Electron
// objects cross the context boundary into the sandboxed renderer.
const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke(CHANNELS.state),
  dispatch: command => ipcRenderer.invoke(CHANNELS.dispatch, command),
  subscribe: listener => {
    if (typeof listener !== 'function') throw new TypeError('监听器必须是函数');
    const wrapped = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on(CHANNELS.changed, wrapped);
    return () => { ipcRenderer.removeListener(CHANNELS.changed, wrapped); };
  },
  getInfo: () => ipcRenderer.invoke(CHANNELS.info),
  exportData: format => ipcRenderer.invoke(CHANNELS.export, format),
  importData: () => ipcRenderer.invoke(CHANNELS.import),
  openDataFolder: () => ipcRenderer.invoke(CHANNELS.openData),
  listBackups: () => ipcRenderer.invoke(CHANNELS.backups),
  restoreBackup: id => ipcRenderer.invoke(CHANNELS.restore, id),
  openQuickCapture: () => ipcRenderer.invoke(CHANNELS.quick),
  windowAction: action => ipcRenderer.invoke(CHANNELS.window, action),
};

contextBridge.exposeInMainWorld('shinian', Object.freeze(bridge));
