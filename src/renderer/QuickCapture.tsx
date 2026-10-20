import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertCircle, ArrowUpRight, Check, ChevronDown, ExternalLink, Inbox, ListTodo, LoaderCircle, Sparkles, X } from 'lucide-react';
import type { AppState, DesktopBridge, ItemKind } from '../shared/types';
import './editor.css';

function singleLine(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' '); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const DRAFT_KEY = 'shinian.quick.draft.v1';
const PROJECT_GLYPHS: Record<string, string> = { sparkles: '✦', folder: '▤', lightbulb: '☀', book: '▥', leaf: '❧', rocket: '↗', heart: '♡', coffee: '☕' };
interface CaptureDraft { kind: ItemKind; title: string; body: string; projectId: string | null; recoveryError?: string }
function recoverDraft(): CaptureDraft {
  const empty: CaptureDraft = { kind: 'idea', title: '', body: '', projectId: null };
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return empty;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('草稿格式不正确');
    const draft = value as Record<string, unknown>;
    if (typeof draft.title !== 'string' || typeof draft.body !== 'string') throw new Error('草稿内容格式不正确');
    return { title: draft.title, body: draft.body, kind: draft.kind === 'todo' ? 'todo' : 'idea', projectId: typeof draft.projectId === 'string' ? draft.projectId : null };
  } catch (reason) { return { ...empty, recoveryError: `上次的快捷草稿未能恢复，原缓存仍会保留。${errorText(reason)}` }; }
}

export function QuickCapture({ bridge }: { bridge: DesktopBridge }) {
  const [initialDraft] = useState(recoverDraft);
  const [state, setState] = useState<AppState | null>(null);
  const [kind, setKind] = useState<ItemKind>(initialDraft.kind);
  const [title, setTitle] = useState(initialDraft.title);
  const [body, setBody] = useState(initialDraft.body);
  const [projectId, setProjectId] = useState<string | null>(initialDraft.projectId);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(initialDraft.recoveryError ?? '');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(initialDraft.title || initialDraft.body ? '上次未保存的草稿已恢复。' : '');
  const [browserMode, setBrowserMode] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);
  const titleElement = useRef<HTMLTextAreaElement>(null);
  const bodyElement = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef(initialDraft.title);
  const bodyRef = useRef(initialDraft.body);
  const kindRef = useRef(initialDraft.kind);
  const projectRef = useRef<string | null>(initialDraft.projectId);
  const editedRef = useRef(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const revisionRef = useRef(-1);
  const hideTimerRef = useRef<number | null>(null);
  const shortcut = /mac/i.test(navigator.platform) ? '⌘ Enter' : 'Ctrl + Enter';

  function cacheDraft(): boolean {
    if (initialDraft.recoveryError && !editedRef.current) return true;
    try {
      if (titleRef.current || bodyRef.current) localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: titleRef.current, body: bodyRef.current, kind: kindRef.current, projectId: projectRef.current }));
      else localStorage.removeItem(DRAFT_KEY);
      return true;
    } catch {
      if (mountedRef.current) setNotice('草稿暂时无法缓存。窗口隐藏后内容仍在，请保存记录后再退出应用。');
      return false;
    }
  }

  function acceptState(next: AppState) {
    if (!mountedRef.current || next.revision < revisionRef.current) return;
    revisionRef.current = next.revision;
    setState(next);
    setLoadError('');
    setLoading(false);
    if (projectRef.current && !next.projects.some(project => project.id === projectRef.current)) {
      projectRef.current = null;
      setProjectId(null);
      setNotice('原项目已删除，这条记录会放进收集箱。');
    }
  }

  async function load() {
    setLoading(true);
    setLoadError('');
    try { acceptState(await bridge.getState()); }
    catch (reason) { if (mountedRef.current) { setLoadError(`暂时无法读取记录。${errorText(reason)}`); setLoading(false); } }
  }

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = bridge.subscribe(acceptState);
    void load();
    void bridge.getInfo().then(info => { if (mountedRef.current) { setBrowserMode(info.mode === 'browser'); if (info.storageWarning) setNotice(info.storageWarning); } }).catch(() => undefined);
    titleElement.current?.focus();
    const guard = (event: BeforeUnloadEvent) => {
      cacheDraft();
      if (savingRef.current || titleRef.current.trim() || bodyRef.current.trim()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      window.removeEventListener('beforeunload', guard);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, [bridge]);

  useEffect(() => {
    const timer = window.setTimeout(cacheDraft, 300);
    return () => window.clearTimeout(timer);
  }, [title, body, kind, projectId]);

  useEffect(() => {
    if (!state) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => { document.documentElement.dataset.theme = state.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.settings.theme; };
    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [state?.settings.theme]);

  async function hide() {
    cacheDraft();
    try { await bridge.windowAction('hide'); }
    catch (reason) { if (mountedRef.current) setError(`窗口暂时无法隐藏，输入内容仍在这里。${errorText(reason)}`); }
  }

  async function openMain() {
    try { await bridge.windowAction('show-main'); }
    catch (reason) { if (mountedRef.current) setError(`未能打开主窗口。${errorText(reason)}`); }
  }

  async function submit() {
    if (savingRef.current || success || loading || !state) return;
    if (!titleRef.current.trim()) { setTitleTouched(true); setError('写个标题，就可以收下这条记录了。'); titleElement.current?.focus(); return; }
    savingRef.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const next = await bridge.dispatch({ type: 'item.create', input: { title: titleRef.current, body: bodyRef.current, kind, projectId: projectRef.current } });
      if (!mountedRef.current) return;
      acceptState(next);
      titleRef.current = '';
      bodyRef.current = '';
      setTitle('');
      setBody('');
      setTitleTouched(false);
      setSuccess(true);
      const cacheCleared = cacheDraft();
      const warnings: string[] = [];
      if (!cacheCleared) warnings.push('记录已保存，但旧草稿缓存未能清除。再次打开时若看到旧稿，请勿重复提交。');
      try {
        const info = await bridge.getInfo();
        if (mountedRef.current) setBrowserMode(info.mode === 'browser');
        if (info.storageWarning) warnings.push(info.storageWarning);
      } catch (reason) { warnings.push(`记录已保存，但暂时无法读取备份状态。${errorText(reason)}`); }
      if (!mountedRef.current) return;
      if (warnings.length) setNotice(warnings.join(' '));
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        if (warnings.length) { if (mountedRef.current) { setSuccess(false); titleElement.current?.focus(); } return; }
        void bridge.windowAction('hide').catch(reason => { if (mountedRef.current) setError(`内容已保存，窗口暂时无法隐藏。${errorText(reason)}`); }).finally(() => { if (mountedRef.current) { setSuccess(false); titleElement.current?.focus(); } });
      }, 380);
    } catch (reason) {
      if (mountedRef.current) setError(`没有保存成功，输入内容已保留。${errorText(reason)}`);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void hide(); }
    else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void submit(); }
  }

  const disabled = saving || success;
  const selectedProject = state?.projects.find(project => project.id === projectId);
  return <main className="quick-app" onKeyDownCapture={keyboard}>
    <header className="quick-header"><div className="quick-brand"><span className="quick-brand-mark"><Sparkles size={22} strokeWidth={1.8} /></span><div><h1>拾念 <span>快速记录</span></h1><p>先收下这一刻，再慢慢整理。</p></div></div><div className="quick-window-actions"><button type="button" className="quick-icon-button" aria-label="打开主窗口" title="打开主窗口" onClick={() => { void openMain(); }}><ExternalLink size={16} /></button><button type="button" className="quick-icon-button" aria-label="隐藏窗口并保留草稿" title="隐藏窗口 · Esc 保留草稿" onClick={() => { void hide(); }}><X size={19} /></button></div></header>
    <div className="quick-kind-row"><div className="quick-kind-switch" role="group" aria-label="记录类型"><button type="button" aria-pressed={kind === 'idea'} className={kind === 'idea' ? 'quick-selected' : ''} disabled={disabled} onClick={() => { editedRef.current = true; kindRef.current = 'idea'; setKind('idea'); }}><Sparkles size={14} />灵感</button><button type="button" aria-pressed={kind === 'todo'} className={kind === 'todo' ? 'quick-selected' : ''} disabled={disabled} onClick={() => { editedRef.current = true; kindRef.current = 'todo'; setKind('todo'); }}><ListTodo size={15} />待办</button></div><span className="quick-local-label"><span />{browserMode ? '浏览器演示 · 本地存储' : '保存在本机'}</span></div>
    <div className={`quick-composer ${titleTouched && !title.trim() ? 'quick-composer-invalid' : ''}`}>
      <label htmlFor="quick-title" className="quick-sr-only">标题</label><textarea ref={titleElement} id="quick-title" className="quick-title" value={title} rows={1} maxLength={1_000} placeholder={kind === 'idea' ? '刚刚，想到了什么？' : '接下来，想完成什么？'} aria-invalid={titleTouched && !title.trim()} disabled={disabled} onChange={event => { const value = singleLine(event.target.value); editedRef.current = true; titleRef.current = value; setTitle(value); setError(''); }} onKeyDown={event => { if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); bodyElement.current?.focus(); } }} />
      <label htmlFor="quick-body" className="quick-sr-only">补充说明</label><textarea ref={bodyElement} id="quick-body" className="quick-body" value={body} maxLength={1_000_000} placeholder="补充一点细节…（可选）" disabled={disabled} onChange={event => { editedRef.current = true; bodyRef.current = event.target.value; setBody(event.target.value); setError(''); }} />
      <div className="quick-composer-footer"><span>不必想完整，记下来就好。</span><span aria-label={`标题 ${title.length} 字，最多 1000 字`}>{title.length.toLocaleString()} / 1,000</span></div>
    </div>
    {(error || loadError || notice || success) && <div className={`quick-message ${error || loadError ? 'quick-message-error' : success ? 'quick-message-success' : ''}`} role={error || loadError ? 'alert' : 'status'}>{error || loadError ? <AlertCircle size={14} /> : success ? <Check size={15} /> : <Inbox size={14} />}<span>{error || loadError || notice || (success ? '已经收好，下次灵感来时再见。' : '')}</span>{loadError && <button type="button" onClick={() => { void load(); }}>重试</button>}</div>}
    <footer className="quick-footer"><div className="quick-project"><span aria-hidden="true" style={{ color: selectedProject?.color }}>{selectedProject ? PROJECT_GLYPHS[selectedProject.icon] || selectedProject.icon : <Inbox size={16} />}</span><label htmlFor="quick-project-select" className="quick-sr-only">保存到项目</label><select id="quick-project-select" value={projectId ?? ''} disabled={disabled || loading || !state} onChange={event => { editedRef.current = true; projectRef.current = event.target.value || null; setProjectId(projectRef.current); setNotice(''); }}><option value="">收集箱</option>{state && [...state.projects].sort((a, b) => a.order - b.order).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></div><div className="quick-submit-group"><span className="quick-shortcut">{shortcut}</span><button type="button" className={`quick-submit ${success ? 'quick-submit-success' : ''}`} disabled={disabled || loading || !state} onClick={() => { void submit(); }}>{saving ? <LoaderCircle className="quick-spinning" size={16} /> : success ? <Check size={17} /> : <ArrowUpRight size={17} />}<span>{saving ? '正在保存…' : success ? '已收好' : kind === 'idea' ? '收下灵感' : '添加待办'}</span></button></div></footer>
    <div className="quick-bottom-hint">{loading ? '正在读取本地记录…' : 'Esc 隐藏窗口，草稿会留在这里。'}</div>
  </main>;
}
