/**
 * Leveled logger.
 *
 * Two properties matter here:
 *  - Everything goes to stderr, so `--json` on stdout stays machine-parsable.
 *  - Every message passes through a sanitiser hook. The kernel installs the
 *    secret redactor at boot, so an accidental `log.debug(fileContents)` cannot
 *    put a live credential on the developer's terminal (spec §26.1 counts the
 *    user-visible debug log as a capture surface).
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

export type Sanitizer = (text: string) => string;

let sanitizer: Sanitizer = (t) => t;

/** Installed once, by the kernel bootstrap, with the session's redactor. */
export function installLogSanitizer(fn: Sanitizer): void {
  sanitizer = fn;
}

export interface Logger {
  readonly level: LogLevel;
  child(scope: string): Logger;
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  trace(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  json?: boolean;
  write?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const scope = opts.scope ?? 'kernel';
  const json = opts.json ?? false;
  const write = opts.write ?? ((line: string) => process.stderr.write(line + '\n'));

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] > ORDER[level]) return;
    const safeMsg = sanitizer(msg);
    if (json) {
      const record: Record<string, unknown> = { level: lvl, scope, msg: safeMsg, ts: Date.now() };
      if (fields) record.fields = sanitizeFields(fields);
      write(sanitizer(JSON.stringify(record)));
      return;
    }
    const suffix = fields ? ' ' + sanitizer(formatFields(fields)) : '';
    write(`${lvl.padEnd(5)} [${scope}] ${safeMsg}${suffix}`);
  };

  return {
    level,
    child: (sub: string) => createLogger({ ...opts, level, scope: `${scope}:${sub}` }),
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
    trace: (m, f) => emit('trace', m, f),
  };
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === 'string' ? sanitizer(v) : v;
  }
  return out;
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

export const nullLogger: Logger = createLogger({ level: 'silent', write: () => {} });
