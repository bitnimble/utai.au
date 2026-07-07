import React from 'react';
import styles from './error_boundary.module.css';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/**
 * App-wide catch-all so a single component throw degrades to a readable card
 * instead of a blank page. Calls out the common cause it can detect, a
 * non-secure context (plain-HTTP LAN IP), which disables AudioWorklet and takes
 * down the audio path, with the fix, since the raw error doesn't say so.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[app] uncaught error:', error, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (error == null) return this.props.children;
    const insecure = typeof window !== 'undefined' && !window.isSecureContext;
    return (
      <div className={styles.overlay} role="alert">
        <div className={styles.card}>
          <h1 className={styles.title}>Something went wrong</h1>
          {insecure && (
            <p className={styles.message}>
              This page isn&rsquo;t running in a secure context, so audio playback
              (AudioWorklet) is unavailable. Open the app over <strong>https://</strong>, or via{' '}
              <strong>localhost</strong> / <strong>127.0.0.1</strong>, instead of a plain-HTTP LAN
              address.
            </p>
          )}
          <p className={styles.detail}>{error.message}</p>
          <button type="button" className={styles.button} onClick={this.reload}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
