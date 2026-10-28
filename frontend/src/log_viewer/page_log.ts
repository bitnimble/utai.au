const LINES_KEPT = 2000;
const VALUE_CHARS_KEPT = 2000;

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const CONSOLE_LEVELS = { debug: 'DEBUG', log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' } as const;

/** The page's recent console output and uncaught errors, for the Settings log viewer. */
export class PageLog {
  private readonly lines: string[] = [];
  private following = false;

  recent(): readonly string[] {
    return this.lines;
  }

  /** Keeps everything the page writes to the console, and every error nothing caught. */
  follow(): void {
    if (this.following) return;
    this.following = true;
    for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
      const name = method as keyof typeof CONSOLE_LEVELS;
      const original = console[name].bind(console);
      console[name] = (...args: unknown[]) => {
        original(...args);
        try {
          this.record(level, args);
        } catch {
          // A value that can't be rendered mustn't throw into the code that logged it.
        }
      };
    }
    window.addEventListener('error', (event) => this.record('ERROR', ['uncaught', event.error ?? event.message]));
    window.addEventListener('unhandledrejection', (event) => this.record('ERROR', ['unhandled', event.reason]));
  }

  record(level: Level, args: readonly unknown[]): void {
    const message = args.map(rendered).join(' ');
    this.lines.push(`${new Date().toISOString()} ${level.padEnd(5)} ${message}`);
    if (this.lines.length > LINES_KEPT) this.lines.shift();
  }
}

function rendered(value: unknown): string {
  const text = renderedWhole(value);
  return text.length > VALUE_CHARS_KEPT ? `${text.slice(0, VALUE_CHARS_KEPT)}…` : text;
}

function renderedWhole(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name}(${value.byteLength} bytes)]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer(${value.byteLength} bytes)]`;
  if (typeof Node !== 'undefined' && value instanceof Node) return `[${value.nodeName}]`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export const pageLog = new PageLog();
