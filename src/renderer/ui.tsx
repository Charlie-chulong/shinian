import { useEffect, useRef, type ReactNode } from 'react';
import { X, Sparkles } from 'lucide-react';
export function Logo({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M20 7.5c.5 8.2 4.3 12 12.5 12.5C24.3 20.5 20.5 24.3 20 32.5 19.5 24.3 15.7 20.5 7.5 20 15.7 19.5 19.5 15.7 20 7.5Z" fill="currentColor"/><path d="M31 5v7M27.5 8.5h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></span>;
}
export function Modal({title, subtitle, children, onClose, wide=false, className=''}:{title:string;subtitle?:string;children:ReactNode;onClose:()=>void;wide?:boolean;className?:string}) {
  const ref=useRef<HTMLDivElement>(null); const close=useRef(onClose); close.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const el=ref.current;
    const focus=()=>el?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button:not(.modal-close)')?.focus();
    const t=setTimeout(focus,40);
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape'&&!e.isComposing){e.preventDefault();close.current();}
      if(e.key==='Tab'&&el){
        const elements=[...el.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')].filter(x=>x.getClientRects().length);
        const first=elements[0],last=elements[elements.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',key); return ()=>{clearTimeout(t);document.removeEventListener('keydown',key);previous?.focus();};
  },[]);
  return <div className="modal-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={ref} className={`modal ${wide?'wide':''} ${className}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div><button className="icon-button modal-close" onClick={onClose} aria-label="关闭弹窗"><X size={19}/></button></header>{children}</div></div>;
}
export function EmptyIllustration({variant='ideas'}:{variant?:string}) {
  return <div className={`empty-illustration ${variant}`} aria-hidden="true"><div className="empty-orbit"/><div className="empty-paper back"/><div className="empty-paper front"><Sparkles size={27}/><span/><span/><span/></div><span className="empty-dot one"/><span className="empty-dot two"/><span className="empty-cross">+</span></div>;
}
export const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
