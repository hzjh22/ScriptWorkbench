import { Component, type ReactNode } from "react";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; message: string }> {
  state = { hasError: false, message: "" };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.stack || error?.message || String(error) };
  }
  componentDidCatch(error: Error) { console.error("AppErrorBoundary caught:", error); }
  render() {
    if (!this.state.hasError) return this.props.children;
    return <div className="shell"><main className="workspace"><section className="panel loading-panel">
      <div className="field"><h2>界面发生错误</h2>
        <p className="muted">这次不会再直接白屏。请把下面的错误信息发给我。</p>
        <pre className="command-preview">{this.state.message}</pre>
        <button className="primary-button" onClick={() => window.location.reload()}>重新加载</button>
      </div></section></main></div>;
  }
}
