import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertCircle, CalendarDays, Check, CheckCircle2, Copy, Eye, Flag, FolderOpen, ListTodo, LoaderCircle, Pencil, Plus, Sparkles, Star, Tag, Trash2, X } from 'lucide-react';
import type { AppState, Command, Item, ItemPatch, ItemStatus, Priority, Project } from '../shared/types';
import './editor.css';

const MAX_TITLE = 1_000;
const MAX_BODY = 1_000_000;
const MAX_TAG = 80;
const MAX_TAGS = 64;
const MAX_SUBTASK = 1_000;
const MAX_SUBTASKS = 1_000;
const PROJECT_GLYPHS: Record<string, string> = { sparkles: '✦', folder: '▤', lightbulb: '☀', book: '▥', leaf: '❧', rocket: '↗', heart: '♡', coffee: '☕' };
const FIELDS = ['title', 'body', 'kind', 'status', 'projectId', 'tags', 'priority', 'dueDate', 'pinned', 'subtasks'] as const;
type Field = typeof FIELDS[number];
type Draft = Pick<Item, Field>;
type SavePhase = 'saved' | 'idle' | 'saving' | 'error' | 'invalid';

function fromItem(item: Item): Draft {
  return {
    title: item.title, body: item.body, kind: item.kind, status: item.status,
    projectId: item.projectId, tags: [...item.tags], priority: item.priority,
    dueDate: item.dueDate, pinned: item.pinned,
    subtasks: item.subtasks.map(task => ({ ...task })),
  };
}

function same(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateDraft(draft: Draft): string | null {
  if (!draft.title.trim()) return '先给这条记录起个名字，填写标题后就会自动保存。';
  if (draft.title.length > MAX_TITLE) return `标题最多 ${MAX_TITLE.toLocaleString()} 字。`;
  if (draft.body.length > MAX_BODY) return `正文最多 ${MAX_BODY.toLocaleString()} 字。`;
  if (draft.subtasks.some(task => !task.text.trim())) return '子任务内容不能为空；可以填写内容，或删除这条子任务。';
  return null;
}

function inlineMarkdown(text: string, key: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g).map((part, index) => {
    const nodeKey = `${key}-${index}`;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={nodeKey}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={nodeKey}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={nodeKey}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** Markdown is rendered as React text nodes only. No raw HTML, remote images or links execute. */
function MarkdownPreview({ body }: { body: string }) {
  if (!body.trim()) return <div className="editor-preview-empty"><Pencil size={20} /><span>这里会呈现你的笔记</span><small>切回「编辑」，写下更多细节。</small></div>;
  const preview = body.slice(0, 100_000);
  const allLines = preview.split('\n');
  const lines = allLines.slice(0, 4_000);
  const nodes: ReactNode[] = [];
  let codeLines: string[] | null = null;
  let list: ReactNode[] = [];
  let ordered = false;
  const flushList = (key: string) => {
    if (list.length) nodes.push(ordered ? <ol key={key}>{list}</ol> : <ul key={key}>{list}</ul>);
    list = [];
  };
  for (const [index, line] of lines.entries()) {
    const key = String(index);
    if (/^\s*```/.test(line)) {
      flushList(`list-${key}`);
      if (codeLines) { nodes.push(<pre key={key}><code>{codeLines.join('\n')}</code></pre>); codeLines = null; }
      else codeLines = [];
      continue;
    }
    if (codeLines) { codeLines.push(line); continue; }
    const bullet = line.match(/^\s*([-*+] |\d+\. )(.*)$/);
    if (bullet) {
      const nextOrdered = /^\d/.test(bullet[1]);
      if (list.length && ordered !== nextOrdered) flushList(`list-${key}`);
      ordered = nextOrdered;
      list.push(<li key={key}>{inlineMarkdown(bullet[2], key)}</li>);
      continue;
    }
    flushList(`list-${key}`);
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const content = inlineMarkdown(heading[2], key);
      nodes.push(heading[1].length === 1 ? <h2 key={key}>{content}</h2> : heading[1].length === 2 ? <h3 key={key}>{content}</h3> : <h4 key={key}>{content}</h4>);
    } else if (/^>\s?/.test(line)) nodes.push(<blockquote key={key}>{inlineMarkdown(line.replace(/^>\s?/, ''), key)}</blockquote>);
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) nodes.push(<hr key={key} />);
    else if (line.trim()) nodes.push(<p key={key}>{inlineMarkdown(line, key)}</p>);
    else nodes.push(<div className="editor-preview-space" key={key} />);
  }
  flushList('last-list');
  if (codeLines) nodes.push(<pre key="last-code"><code>{codeLines.join('\n')}</code></pre>);
  return <div className="editor-markdown">{nodes}{(body.length > preview.length || allLines.length > lines.length) && <p className="editor-preview-note">为保持流畅，预览最多显示 100,000 字或 4,000 行；完整正文仍会保存。</p>}</div>;
}

export interface EditorPanelProps {
  item: Item;
  projects: Project[];
  revision?: number;
  onCommand: (command: Command) => Promise<AppState>;
  onClose: () => void;
  onError: (message: string) => void;
}

export function EditorPanel({ item, projects, revision, onCommand, onClose, onError }: EditorPanelProps) {
  const [draft, setDraft] = useState<Draft>(() => fromItem(item));
  const [savePhase, setSavePhase] = useState<SavePhase>('saved');
  const [saveError, setSaveError] = useState('');
  const [editTick, setEditTick] = useState(0);
  const [closing, setClosing] = useState(false);
  const [unavailable, setUnavailable] = useState(Boolean(item.deletedAt));
  const [preview, setPreview] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [subtaskInput, setSubtaskInput] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const subtaskRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  const baselineRef = useRef(fromItem(item));
  const latestItemRef = useRef(item);
  const latestRevisionRef = useRef(revision);
  const dirtyRef = useRef(new Set<Field>());
  const versionRef = useRef(Object.fromEntries(FIELDS.map(field => [field, 0])) as Record<Field, number>);
  const pendingFieldsRef = useRef(new Set<Field>());
  const pendingRef = useRef<Promise<boolean> | null>(null);
  const saveOnceRef = useRef<() => Promise<boolean>>(async () => true);
  const closeRef = useRef<() => Promise<void>>(async () => undefined);
  const commandRef = useRef(onCommand);
  const errorRef = useRef(onError);
  const closeCallbackRef = useRef(onClose);
  const tagInputRef = useRef('');
  const subtaskInputRef = useRef('');
  const unavailableRef = useRef(Boolean(item.deletedAt));
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const itemIdRef = useRef(item.id);
  latestItemRef.current = item;
  latestRevisionRef.current = revision;
  commandRef.current = onCommand;
  errorRef.current = onError;
  closeCallbackRef.current = onClose;

  function change<K extends Field>(field: K, value: Draft[K]) {
    if (closingRef.current || unavailableRef.current || same(draftRef.current[field], value)) return;
    const next = { ...draftRef.current, [field]: value };
    draftRef.current = next;
    versionRef.current[field] += 1;
    if (pendingFieldsRef.current.has(field) || !same(value, baselineRef.current[field])) dirtyRef.current.add(field);
    else dirtyRef.current.delete(field);
    setDraft(next);
    setSaveError('');
    setSavePhase(dirtyRef.current.size ? 'idle' : 'saved');
    setEditTick(value => value + 1);
  }

  useEffect(() => {
    if (item.id !== itemIdRef.current) return;
    const remote = fromItem(item);
    baselineRef.current = remote;
    if (item.deletedAt) {
      unavailableRef.current = true;
      setUnavailable(true);
      return;
    }
    unavailableRef.current = false;
    setUnavailable(false);
    const next = { ...draftRef.current };
    for (const field of FIELDS) {
      if (!dirtyRef.current.has(field) && !pendingFieldsRef.current.has(field)) Object.assign(next, { [field]: remote[field] });
      else if (!pendingFieldsRef.current.has(field) && same(next[field], remote[field])) dirtyRef.current.delete(field);
    }
    if (!same(next, draftRef.current)) {
      draftRef.current = next;
      setDraft(next);
    }
    if (!dirtyRef.current.size && !pendingRef.current) { setSavePhase('saved'); setSaveError(''); }
  }, [item]);

  useLayoutEffect(() => {
    if (!titleRef.current) return;
    titleRef.current.style.height = 'auto';
    titleRef.current.style.height = `${Math.min(172, Math.max(44, titleRef.current.scrollHeight))}px`;
  }, [draft.title]);

  useEffect(() => {
    mountedRef.current = true;
    const previous = document.activeElement;
    titleRef.current?.focus();
    const guard = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current.size || pendingRef.current || tagInputRef.current.trim() || subtaskInputRef.current.trim()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('beforeunload', guard);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  async function saveOnce(): Promise<boolean> {
    if (pendingRef.current) return pendingRef.current;
    if (!dirtyRef.current.size) return true;
    if (unavailableRef.current) {
      setSaveError('这条记录已删除，当前草稿还在这里。请先复制需要保留的内容。');
      setSavePhase('error');
      return false;
    }
    const validation = validateDraft(draftRef.current);
    if (validation) {
      setTitleTouched(true);
      setSaveError(validation);
      setSavePhase('invalid');
      return false;
    }
    const fields = FIELDS.filter(field => dirtyRef.current.has(field));
    // The reducer deliberately resets an idea's status unless the patch explicitly preserves done.
    if (fields.includes('kind') && draftRef.current.kind === 'idea' && !fields.includes('status')) fields.push('status');
    const patch = Object.fromEntries(fields.map(field => [field, draftRef.current[field]])) as ItemPatch;
    if (patch.kind === 'idea' && patch.status !== 'done') patch.status = 'open';
    const versions = { ...versionRef.current };
    const startedWithItem = latestItemRef.current;
    pendingFieldsRef.current = new Set(fields);
    setSavePhase('saving');
    setSaveError('');
    const operation = (async () => {
      try {
        const state = await Promise.resolve().then(() => commandRef.current({ type: 'item.update', id: itemIdRef.current, patch }));
        const saved = state.items.find(candidate => candidate.id === itemIdRef.current);
        if (!saved || saved.deletedAt) {
          unavailableRef.current = true;
          if (mountedRef.current) setUnavailable(true);
          throw new Error('这条记录已删除，无法写入修改。');
        }
        const observed = latestItemRef.current;
        // Prefer a later remote update when it has already reached the parent while awaiting dispatch.
        const observedRevision = latestRevisionRef.current;
        const observedIsLater = observedRevision === undefined
          ? observed !== startedWithItem && observed.updatedAt >= saved.updatedAt
          : observedRevision >= state.revision;
        const current = observedIsLater ? observed : saved;
        const baseline = fromItem(current);
        baselineRef.current = baseline;
        const next = { ...draftRef.current };
        for (const field of FIELDS) {
          if (fields.includes(field) && versionRef.current[field] === versions[field]) dirtyRef.current.delete(field);
          else if (dirtyRef.current.has(field) && same(next[field], baseline[field])) dirtyRef.current.delete(field);
          if (!dirtyRef.current.has(field)) Object.assign(next, { [field]: baseline[field] });
        }
        draftRef.current = next;
        if (mountedRef.current) {
          setDraft(next);
          setSavePhase(dirtyRef.current.size ? 'idle' : 'saved');
          setSaveError('');
          setEditTick(value => value + 1);
        }
        return true;
      } catch (error) {
        // Edits made during this request stay in the draft, including a revert of an in-flight value.
        for (const field of fields) {
          if (same(draftRef.current[field], baselineRef.current[field])) dirtyRef.current.delete(field);
          else dirtyRef.current.add(field);
        }
        const message = `保存失败，输入内容已保留。${errorText(error)}`;
        if (mountedRef.current) { setSavePhase('error'); setSaveError(message); }
        errorRef.current(message);
        return false;
      } finally {
        pendingFieldsRef.current.clear();
        pendingRef.current = null;
      }
    })();
    pendingRef.current = operation;
    return operation;
  }
  saveOnceRef.current = saveOnce;

  useEffect(() => {
    if (!dirtyRef.current.size || savePhase === 'error' || savePhase === 'invalid' || savePhase === 'saving' || unavailable || closing) return;
    const timer = window.setTimeout(() => { void saveOnceRef.current(); }, 500);
    return () => window.clearTimeout(timer);
  }, [editTick, savePhase, unavailable, closing]);

  function showValidation(message: string) {
    setSaveError(message);
    setSavePhase('invalid');
  }

  function commitTag(): boolean {
    const value = tagInputRef.current.trim().normalize('NFC');
    if (!value) { tagInputRef.current = ''; setTagInput(''); return true; }
    if (value.length > MAX_TAG) { showValidation(`每个标签最多 ${MAX_TAG} 字。`); tagRef.current?.focus(); return false; }
    const values = value.split(/[,，]/).map(tag => singleLine(tag).trim()).filter(Boolean);
    const tags = Array.from(new Set([...draftRef.current.tags, ...values]));
    if (tags.length > MAX_TAGS) { showValidation(`最多添加 ${MAX_TAGS} 个标签。`); tagRef.current?.focus(); return false; }
    change('tags', tags);
    tagInputRef.current = '';
    setTagInput('');
    return true;
  }

  function commitSubtask(): boolean {
    const text = singleLine(subtaskInputRef.current).trim().normalize('NFC');
    if (!text) { subtaskInputRef.current = ''; setSubtaskInput(''); return true; }
    if (draftRef.current.subtasks.length >= MAX_SUBTASKS) { showValidation(`最多添加 ${MAX_SUBTASKS.toLocaleString()} 条子任务。`); subtaskRef.current?.focus(); return false; }
    change('subtasks', [...draftRef.current.subtasks, { id: crypto.randomUUID(), text, done: false }]);
    subtaskInputRef.current = '';
    setSubtaskInput('');
    return true;
  }

  async function saveAndClose() {
    if (closingRef.current) return;
    if (unavailableRef.current && (dirtyRef.current.size || tagInputRef.current.trim() || subtaskInputRef.current.trim())) {
      setSaveError('这条记录已删除，当前草稿还在这里。请先复制需要保留的内容。');
      setSavePhase('error');
      return;
    }
    if (!commitTag() || !commitSubtask()) return;
    closingRef.current = true;
    setClosing(true);
    try {
      do {
        const ok = await saveOnceRef.current();
        if (!ok) { if (!draftRef.current.title.trim()) titleRef.current?.focus(); return; }
      } while (dirtyRef.current.size || pendingRef.current);
      closeCallbackRef.current();
    } finally {
      closingRef.current = false;
      if (mountedRef.current) setClosing(false);
    }
  }
  closeRef.current = saveAndClose;

  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) {
      event.preventDefault();
      event.stopPropagation();
      void closeRef.current();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')).filter(element => element.offsetParent !== null);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  async function copyDraft() {
    const value = draftRef.current;
    const tasks = [...value.subtasks.map(task => `- [${task.done ? 'x' : ' '}] ${task.text}`), ...(subtaskInputRef.current.trim() ? [`- [ ] ${subtaskInputRef.current.trim()}`] : [])].join('\n');
    const tags = [...value.tags, ...(tagInputRef.current.trim() ? [tagInputRef.current.trim()] : [])];
    try {
      await navigator.clipboard.writeText(`# ${value.title}\n\n${value.body}${tasks ? `\n\n${tasks}` : ''}${tags.length ? `\n\n${tags.map(tag => `#${tag}`).join(' ')}` : ''}`);
      setCopied(true);
    } catch (error) { showValidation(`未能复制，请直接选中编辑器中的文字复制。${errorText(error)}`); }
  }

  const doneTasks = draft.subtasks.filter(task => task.done).length;
  const disabled = closing || unavailable;
  const titleInvalid = titleTouched && !draft.title.trim();
  const statusText = unavailable ? '记录已删除' : savePhase === 'saving' ? '正在保存…' : savePhase === 'error' ? '保存失败 · 草稿已保留' : savePhase === 'invalid' ? '还有内容需要填写' : savePhase === 'idle' ? '等待保存…' : '已保存到本机';
  const createdAt = new Date(item.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  return <div className="editor-overlay">
    <button className="editor-backdrop" tabIndex={-1} aria-label="保存并关闭编辑器" onClick={() => { void saveAndClose(); }} />
    <section className="editor-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="editor-heading" onKeyDownCapture={keyboard} tabIndex={-1}>
      <header className="editor-topbar">
        <div className="editor-context"><span className={`editor-kind-dot editor-kind-dot-${draft.kind}`}>{draft.kind === 'idea' ? <Sparkles size={16} /> : <ListTodo size={16} />}</span><span id="editor-heading">{draft.kind === 'idea' ? '一份灵感' : '一件待办'}</span></div>
        <div className="editor-top-actions"><button type="button" className={`editor-icon-button ${draft.pinned ? 'editor-is-pinned' : ''}`} aria-label={draft.pinned ? '取消星标' : '星标收藏'} aria-pressed={draft.pinned} title={draft.pinned ? '取消星标' : '星标收藏'} disabled={disabled} onClick={() => change('pinned', !draft.pinned)}><Star size={17} fill={draft.pinned ? 'currentColor' : 'none'} /></button><button type="button" className="editor-icon-button" aria-label="保存并关闭" title="保存并关闭 · Esc" disabled={closing} onClick={() => { void saveAndClose(); }}><X size={20} /></button></div>
      </header>

      <div className="editor-main">
        {unavailable && <div className="editor-alert" role="alert"><AlertCircle size={17} /><div>这条记录已删除。未保存的草稿仍保留在这里。<button type="button" className="editor-text-button" onClick={() => { void copyDraft(); }}><Copy size={13} />{copied ? '已复制草稿' : '复制草稿'}</button></div></div>}
        <div className="editor-title-wrap">
          <label className="editor-sr-only" htmlFor="editor-title">标题</label>
          <textarea ref={titleRef} id="editor-title" className={`editor-title ${titleInvalid ? 'editor-input-invalid' : ''}`} value={draft.title} maxLength={MAX_TITLE} rows={1} placeholder={draft.kind === 'idea' ? '给灵感起个名字…' : '有什么想完成的？'} disabled={disabled} aria-invalid={titleInvalid} aria-describedby="editor-title-count" onChange={event => change('title', singleLine(event.target.value))} onBlur={() => setTitleTouched(true)} onKeyDown={event => { if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); bodyRef.current?.focus(); } }} />
          <span className={`editor-character-count ${draft.title.length > MAX_TITLE * .9 ? 'editor-count-near' : ''}`} id="editor-title-count">{draft.title.length.toLocaleString()} / {MAX_TITLE.toLocaleString()}</span>
        </div>

        <div className="editor-kind-switch" role="group" aria-label="记录类型">
          <button type="button" className={draft.kind === 'idea' ? 'editor-selected' : ''} aria-pressed={draft.kind === 'idea'} disabled={disabled} onClick={() => { change('kind', 'idea'); if (draftRef.current.status === 'doing') change('status', 'open'); }}><Sparkles size={15} />灵感</button>
          <button type="button" className={draft.kind === 'todo' ? 'editor-selected' : ''} aria-pressed={draft.kind === 'todo'} disabled={disabled} onClick={() => change('kind', 'todo')}><ListTodo size={15} />待办</button>
        </div>

        <div className="editor-details">
          <label htmlFor="editor-project"><FolderOpen size={15} />所属项目</label>
          <select id="editor-project" value={draft.projectId ?? ''} disabled={disabled} onChange={event => change('projectId', event.target.value || null)}><option value="">收集箱</option>{[...projects].sort((a, b) => a.order - b.order).map(project => <option key={project.id} value={project.id}>{PROJECT_GLYPHS[project.icon] || project.icon} {project.name}</option>)}</select>
          <label htmlFor="editor-status"><CheckCircle2 size={15} />当前状态</label>
          <select id="editor-status" value={draft.status} disabled={disabled} onChange={event => change('status', event.target.value as ItemStatus)}><option value="open">{draft.kind === 'idea' ? '未完成' : '待开始'}</option>{draft.kind === 'todo' && <option value="doing">进行中</option>}<option value="done">已完成</option></select>
          <label htmlFor="editor-date"><CalendarDays size={15} />截止日期</label>
          <div className="editor-date-control"><input id="editor-date" aria-label="截止日期" type="date" min="0001-01-01" max="9999-12-31" value={draft.dueDate ?? ''} disabled={disabled} onChange={event => change('dueDate', event.target.value || null)} />{draft.dueDate && <button type="button" className="editor-icon-button editor-small-icon" aria-label="清除截止日期" title="清除日期" disabled={disabled} onClick={() => change('dueDate', null)}><X size={14} /></button>}</div>
          <label htmlFor="editor-priority"><Flag size={15} />优先级</label>
          <select id="editor-priority" className={`editor-priority-${draft.priority}`} value={draft.priority} disabled={disabled} onChange={event => change('priority', event.target.value as Priority)}><option value="none">无优先级</option><option value="low">低 · 不着急</option><option value="medium">中 · 记得完成</option><option value="high">高 · 优先处理</option></select>
          <label htmlFor="editor-tag-input"><Tag size={15} />标签</label>
          <div className="editor-tag-field"><div className="editor-tags">{draft.tags.map(tag => <span className="editor-tag" key={tag}><span>{tag}</span><button type="button" aria-label={`删除标签 ${tag}`} disabled={disabled} onClick={() => change('tags', draft.tags.filter(value => value !== tag))}><X size={11} /></button></span>)}</div><input id="editor-tag-input" ref={tagRef} value={tagInput} maxLength={MAX_TAG} disabled={disabled || draft.tags.length >= MAX_TAGS} placeholder={draft.tags.length ? '+ 添加标签' : '添加标签，按 Enter 确认'} onChange={event => { const value = singleLine(event.target.value); tagInputRef.current = value; setTagInput(value); }} onBlur={() => { if (!closingRef.current && !unavailableRef.current) commitTag(); }} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.keyCode !== 229 && (event.key === 'Enter' || event.key === ',' || event.key === '，')) { event.preventDefault(); event.stopPropagation(); commitTag(); } }} /></div>
        </div>

        <section className="editor-body-section" aria-labelledby="editor-notes-heading">
          <div className="editor-section-heading"><h3 id="editor-notes-heading">笔记</h3><div className="editor-preview-switch" role="group" aria-label="笔记模式"><button type="button" aria-pressed={!preview} className={!preview ? 'editor-selected' : ''} onClick={() => setPreview(false)}><Pencil size={12} />编辑</button><button type="button" aria-pressed={preview} className={preview ? 'editor-selected' : ''} onClick={() => setPreview(true)}><Eye size={13} />预览</button></div></div>
          {preview ? <div className="editor-preview" tabIndex={0}><MarkdownPreview body={draft.body} /></div> : <><label className="editor-sr-only" htmlFor="editor-body">笔记正文</label><textarea id="editor-body" ref={bodyRef} className="editor-body" value={draft.body} maxLength={MAX_BODY} placeholder={'把脑海里的碎片写下来…\n\n可以是几句话、一份清单，或一个还没想完整的点子。'} disabled={disabled} onChange={event => change('body', event.target.value)} /></>}
          <div className="editor-body-caption"><span>支持基础 Markdown</span><span>{draft.body.length.toLocaleString()} 字</span></div>
        </section>

        <section className="editor-subtasks-section" aria-labelledby="editor-subtasks-heading">
          <div className="editor-section-heading"><h3 id="editor-subtasks-heading">子任务 <span>{draft.subtasks.length ? `${doneTasks} / ${draft.subtasks.length}` : ''}</span></h3>{draft.subtasks.length > 0 && <span className="editor-progress-track" role="progressbar" aria-label="子任务完成进度" aria-valuenow={doneTasks} aria-valuemin={0} aria-valuemax={draft.subtasks.length}><span style={{ width: `${doneTasks / draft.subtasks.length * 100}%` }} /></span>}</div>
          <div className="editor-subtasks">{draft.subtasks.map((task, index) => <div className={`editor-subtask ${task.done ? 'editor-subtask-done' : ''}`} key={task.id}><input type="checkbox" checked={task.done} aria-label={`${task.done ? '取消完成' : '完成'}子任务 ${task.text || index + 1}`} disabled={disabled} onChange={() => change('subtasks', draft.subtasks.map(value => value.id === task.id ? { ...value, done: !value.done } : value))} /><input type="text" aria-label={`子任务 ${index + 1} 内容`} aria-invalid={!task.text.trim()} value={task.text} maxLength={MAX_SUBTASK} disabled={disabled} onChange={event => change('subtasks', draft.subtasks.map(value => value.id === task.id ? { ...value, text: singleLine(event.target.value) } : value))} /><button type="button" className="editor-icon-button editor-small-icon editor-delete-subtask" aria-label={`删除子任务 ${task.text || index + 1}`} disabled={disabled} onClick={() => change('subtasks', draft.subtasks.filter(value => value.id !== task.id))}><Trash2 size={14} /></button></div>)}</div>
          <div className="editor-add-subtask"><Plus size={16} /><input ref={subtaskRef} value={subtaskInput} maxLength={MAX_SUBTASK} disabled={disabled || draft.subtasks.length >= MAX_SUBTASKS} aria-label="添加子任务" placeholder="拆成一小步，按 Enter 添加" onChange={event => { const value = singleLine(event.target.value); subtaskInputRef.current = value; setSubtaskInput(value); }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); commitSubtask(); } }} /><button type="button" className="editor-text-button" disabled={disabled || !subtaskInput.trim()} onClick={commitSubtask}>添加</button></div>
        </section>

        <p className="editor-created-at">创建于 {createdAt}</p>
      </div>

      <footer className="editor-footer">
        {saveError && <div className={`editor-save-error ${savePhase === 'invalid' ? 'editor-validation' : ''}`} role="alert"><AlertCircle size={15} /><span>{saveError}</span></div>}
        <div className="editor-footer-actions"><div className={`editor-save-state editor-save-state-${savePhase}`} role="status" aria-live="polite">{savePhase === 'saving' || closing ? <LoaderCircle className="editor-spinning" size={14} /> : savePhase === 'error' || unavailable ? <AlertCircle size={14} /> : savePhase === 'saved' ? <Check size={14} /> : <span className="editor-unsaved-dot" />}<span>{statusText}</span></div>{savePhase === 'error' && !unavailable ? <button type="button" className="editor-primary-button" disabled={closing} onClick={() => { void saveOnce(); }}>重试保存</button> : <button type="button" className="editor-primary-button" disabled={closing} onClick={() => { void saveAndClose(); }}>{closing ? '保存中…' : '完成编辑'}</button>}</div>
        {unavailable && (dirtyRef.current.size > 0 || tagInput.trim() || subtaskInput.trim()) ? <button type="button" className="editor-discard-button" onClick={() => { if (window.confirm('确定放弃此处尚未保存的草稿并关闭吗？')) { dirtyRef.current.clear(); tagInputRef.current = ''; subtaskInputRef.current = ''; closeCallbackRef.current(); } }}>放弃草稿并关闭</button> : <div className="editor-key-hint">修改后自动保存 <span>·</span> Ctrl / ⌘ + Enter 完成</div>}
      </footer>
    </section>
  </div>;
}
