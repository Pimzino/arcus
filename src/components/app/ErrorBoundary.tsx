import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeError, reportError } from "../../lib/errorLog";
import { Button, Callout } from "../ui";

/**
 * Catches a crash while rendering what it wraps, logs it, and shows what went wrong in its place, so one broken
 * part of the window (a dialog, say) doesn't leave the whole window blank. `resetKey` changing clears the error.
 */
export class ErrorBoundary extends Component<{ where: string; children: ReactNode; resetKey?: unknown; onClose?: () => void }, { error: unknown; resetKey?: unknown }> {
  state: { error: unknown; resetKey?: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: unknown; resetKey?: unknown }) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportError(this.props.where, error, info.componentStack ?? undefined);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-4">
        <Callout
          tone="danger"
          title="Something went wrong here"
          action={
            this.props.onClose ? (
              <Button size="sm" onClick={this.props.onClose}>
                Close
              </Button>
            ) : (
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload
              </Button>
            )
          }
        >
          <p>The error is in the app log (arcus.log). Its details:</p>
          <pre className="mt-2 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap">{describeError(this.state.error)}</pre>
        </Callout>
      </div>
    );
  }
}
