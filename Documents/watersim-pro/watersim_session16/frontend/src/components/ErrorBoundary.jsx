import { Component } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

/**
 * ErrorBoundary — catches unhandled React render errors and shows a friendly
 * recovery UI instead of a blank white screen.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <SomeComponent />
 *   </ErrorBoundary>
 *
 *   <ErrorBoundary fallback={<p>Oops</p>}>…</ErrorBoundary>
 *
 *   <ErrorBoundary scope="Canvas">…</ErrorBoundary>  ← names the section in the error msg
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    // In production you'd send this to Sentry / Datadog etc.
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    // Allow a fully-custom fallback
    if (this.props.fallback) {
      return typeof this.props.fallback === 'function'
        ? this.props.fallback({ error: this.state.error, reset: this.handleReset })
        : this.props.fallback;
    }

    const scope = this.props.scope ?? 'This section';
    const isDev = import.meta.env.DEV;

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex flex-col items-center justify-center min-h-[320px] p-8 text-center"
      >
        <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center mb-4">
          <AlertTriangle className="w-7 h-7 text-red-500" aria-hidden="true" />
        </div>

        <h2 className="text-lg font-semibold text-gray-900 mb-1">
          Something went wrong
        </h2>
        <p className="text-sm text-gray-500 mb-6 max-w-sm">
          {scope} encountered an unexpected error. You can try reloading this section or go back to
          the dashboard.
        </p>

        {/* Dev-mode stack trace */}
        {isDev && this.state.error && (
          <details className="mb-6 w-full max-w-lg text-left">
            <summary className="text-xs font-mono text-red-600 cursor-pointer hover:text-red-700 mb-1">
              Error details (dev only)
            </summary>
            <pre className="text-xs bg-red-50 border border-red-200 rounded-lg p-3 overflow-x-auto text-red-700 whitespace-pre-wrap break-all">
              {this.state.error.toString()}
              {this.state.errorInfo?.componentStack}
            </pre>
          </details>
        )}

        <div className="flex gap-3">
          <button
            onClick={this.handleReset}
            className="btn-secondary text-sm"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            Try again
          </button>
          <a href="/dashboard" className="btn-primary text-sm">
            <Home className="w-4 h-4" aria-hidden="true" />
            Go to Dashboard
          </a>
        </div>
      </div>
    );
  }
}

/**
 * HOC helper — wrap a page component with an error boundary automatically.
 * Usage: export default withErrorBoundary(MyPage, { scope: 'Projects' });
 */
export function withErrorBoundary(WrappedComponent, options = {}) {
  const displayName = options.scope ?? WrappedComponent.displayName ?? WrappedComponent.name ?? 'Component';
  function Wrapper(props) {
    return (
      <ErrorBoundary scope={displayName} {...options}>
        <WrappedComponent {...props} />
      </ErrorBoundary>
    );
  }
  Wrapper.displayName = `withErrorBoundary(${displayName})`;
  return Wrapper;
}
