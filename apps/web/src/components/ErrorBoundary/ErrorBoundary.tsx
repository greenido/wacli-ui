import React from 'react';
import { AlertOctagon, RotateCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  /** Rendered instead of the default panel, for boundaries around one pane. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The console's backstop against a render that throws.
 *
 * React unmounts the whole tree when a render throws and nothing catches it, so
 * one bad message — an unexpected shape from a contact, a field the archive
 * left null — took the entire console down to a blank page, with the reason
 * only in a console log nobody had open. The operator's only recovery was to
 * guess that a reload would help.
 *
 * The error is deliberately shown rather than summarised: this is a local
 * operator tool, the person reading it is the person who can act on it, and a
 * stack that names the component beats "something went wrong".
 */
export class ErrorBoundary extends React.Component<Props, State> {
  public state: State = { error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  public componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The browser console is where a local operator would look next, and the
    // component stack is the part React does not put in the error itself.
    console.error('Console render failed:', error, info.componentStack);
  }

  /**
   * Drops the error and re-renders the children. Worth offering because most
   * of what reaches here is one bad row in live data: the next poll or socket
   * message usually replaces it, and a retry costs nothing if it does not.
   */
  private reset = (): void => {
    this.setState({ error: null });
  };

  public render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        role="alert"
        className="h-full w-full flex items-center justify-center bg-mc-bg text-mc-text p-6 font-sans"
      >
        <div className="max-w-lg w-full bg-mc-surface border border-mc-danger/50 rounded p-5 space-y-4">
          <h1 className="flex items-center gap-2 font-mono font-semibold text-sm text-mc-danger">
            <AlertOctagon size={16} className="shrink-0" />
            <span>THE CONSOLE HIT AN ERROR</span>
          </h1>

          <p className="text-[12px] leading-relaxed text-mc-textMuted">
            Nothing was sent and nothing was lost — this is the display giving up, not
            the archive. Retrying re-renders from current data, which is usually enough
            when one message was the cause.
          </p>

          <pre className="text-[11px] font-mono text-mc-danger bg-mc-bg border border-mc-border rounded p-3 overflow-x-auto whitespace-pre-wrap break-words">
            {error.message || String(error)}
          </pre>

          <button
            type="button"
            onClick={this.reset}
            className="flex items-center gap-1.5 bg-mc-surfaceHover hover:bg-mc-border text-mc-text border border-mc-border px-3 py-1.5 rounded text-[11px] font-mono font-semibold transition-all"
          >
            <RotateCw size={12} />
            <span>RETRY</span>
          </button>
        </div>
      </div>
    );
  }
}
