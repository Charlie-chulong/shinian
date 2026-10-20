import React, { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { QuickCapture } from './QuickCapture';
import { getBridge } from './bridge';
import './styles.css';
class ErrorBoundary extends Component<{children:ReactNode},{error:string}> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main className="fatal-screen"><div className="brand-mark">拾</div><h1>拾念暂时没有打开</h1><p>{this.state.error}</p><p>已保存的数据会保留。你可以重新打开软件，或从数据目录取回备份。</p><button className="primary-button" onClick={() => location.reload()}>重新打开</button></main>;
    return this.props.children;
  }
}
function Root() {
  const bridge = React.useMemo(getBridge, []);
  return new URLSearchParams(location.search).get('quick') === '1' ? <QuickCapture bridge={bridge}/> : <App bridge={bridge}/>;
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><Root/></ErrorBoundary>);
