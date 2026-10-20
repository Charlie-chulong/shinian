// Test-only renderer fixture with an in-memory controlled bridge. Never imported by the production app.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/styles.css';
import { EditorPanel } from '../../src/renderer/EditorPanel';
import { QuickCapture } from '../../src/renderer/QuickCapture';
import { applyCommand, createEmptyState } from '../../src/shared/domain';
import type { AppState, Command, DesktopBridge } from '../../src/shared/types';
const FIXED_NOW = '2026-10-19T10:00:00.000Z';
let current = applyCommand(createEmptyState(FIXED_NOW), { type: 'project.create', name: '产品实验室', color: '#7564df', icon: 'sparkles' }, FIXED_NOW);
current = applyCommand(current, { type: 'item.create', input: { title: '原始标题', body: '原始正文', kind: 'idea', projectId: current.projects[0].id } }, FIXED_NOW);
const itemId = current.items[0].id;
const subscribers = new Set<(value: AppState) => void>();
const testing = {
  delay: 0, responseDelay: 0, failCount: 0, infoWarning: '', commands: [] as Command[], errors: [] as string[], actions: [] as string[], closed: false,
  state: () => structuredClone(current),
  remote: (command: Command) => { current = applyCommand(current, command, FIXED_NOW); subscribers.forEach(listener => listener(current)); },
  itemId,
};
(window as any).testing = testing;
const bridge: DesktopBridge = {
  getState: async () => current,
  dispatch: async command => {
    testing.commands.push(structuredClone(command));
    if (testing.delay) await new Promise(resolve => setTimeout(resolve, testing.delay));
    if (testing.failCount > 0) { testing.failCount--; throw new Error('模拟磁盘写入失败'); }
    current = applyCommand(current, command, FIXED_NOW);
    const result = current;
    subscribers.forEach(listener => listener(current));
    if (testing.responseDelay) await new Promise(resolve => setTimeout(resolve, testing.responseDelay));
    return result;
  },
  subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener); },
  getInfo: async () => ({ version: 'test', mode: 'browser', platform: 'web', dataPath: 'Test only', shortcutRegistered: true, storageWarning: testing.infoWarning }),
  windowAction: async action => { testing.actions.push(action); },
  exportData: async () => ({ canceled: true }), importData: async () => ({ canceled: true }),
  openDataFolder: async () => undefined, listBackups: async () => [], restoreBackup: async () => current, openQuickCapture: async () => undefined,
};
function Harness() {
  const [state, setState] = useState(current);
  const latest = useRef(state);
  const [closed, setClosed] = useState(false);
  const selectedSnapshot = useRef(state.items[0]);
  const accept = (next: AppState) => { if (next.revision >= latest.current.revision) { latest.current = next; setState(next); } };
  useEffect(() => bridge.subscribe(accept), []);
  const selected = state.items.find(item => item.id === itemId);
  if (selected) selectedSnapshot.current = selected;
  const item = selected ?? { ...selectedSnapshot.current, deletedAt: FIXED_NOW };
  if (location.search.includes('quick')) return <QuickCapture bridge={bridge} />;
  return <main><div style={{ padding: 60 }}><h1>拾念 · 编辑器交互验证</h1><p>此页面仅供交互测试，不属于正式应用。</p></div>{closed ? <p id="closed">已关闭</p> : <EditorPanel item={item} revision={state.revision} projects={state.projects} onCommand={async command => { const next = await bridge.dispatch(command); accept(next); return next; }} onClose={() => { testing.closed = true; setClosed(true); }} onError={message => testing.errors.push(message)} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
