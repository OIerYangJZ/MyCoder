/**
 * TOML subset parser for kernel configuration.
 *
 * Covers what the spec's config files actually use: tables, arrays of tables,
 * dotted keys, basic/literal/multi-line strings, integers, floats, booleans and
 * inline arrays. Datetimes are returned as strings — the kernel has no config
 * field that needs a real Date, and parsing them would only add attack surface.
 */

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };
export type TomlTable = { [k: string]: TomlValue };

export class TomlParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'TomlParseError';
    this.line = line;
  }
}

export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  // Tables that were created by a `[a.b]` header, so we can reject redefinition.
  const definedTables = new Set<string>();
  const arrayTables = new Set<string>();

  let current: TomlTable = root;
  let currentPath: string[] = [];

  const lines = source.split(/\r?\n/);

  for (let n = 0; n < lines.length; n += 1) {
    const raw = lines[n]!;
    const lineNo = n + 1;
    const line = stripComment(raw).trim();
    if (line === '') continue;

    if (line.startsWith('[[')) {
      const end = line.indexOf(']]');
      if (end < 0) throw new TomlParseError('unterminated array-of-tables header', lineNo);
      const keyPath = parseKeyPath(line.slice(2, end), lineNo);
      const joined = keyPath.join('.');
      arrayTables.add(joined);
      const parent = descend(root, keyPath.slice(0, -1), lineNo);
      const last = keyPath.at(-1)!;
      const existing = parent[last];
      const arr: TomlValue[] = Array.isArray(existing) ? existing : [];
      if (!Array.isArray(existing) && existing !== undefined) {
        throw new TomlParseError(`cannot redefine ${joined} as an array of tables`, lineNo);
      }
      const entry: TomlTable = {};
      arr.push(entry);
      parent[last] = arr;
      current = entry;
      currentPath = keyPath;
      continue;
    }

    if (line.startsWith('[')) {
      const end = line.indexOf(']');
      if (end < 0) throw new TomlParseError('unterminated table header', lineNo);
      const keyPath = parseKeyPath(line.slice(1, end), lineNo);
      const joined = keyPath.join('.');
      if (definedTables.has(joined)) throw new TomlParseError(`duplicate table [${joined}]`, lineNo);
      definedTables.add(joined);
      current = descend(root, keyPath, lineNo);
      currentPath = keyPath;
      continue;
    }

    const eq = findAssignment(line);
    if (eq < 0) throw new TomlParseError(`expected key = value`, lineNo);

    const keyPath = parseKeyPath(line.slice(0, eq), lineNo);
    let valueText = line.slice(eq + 1).trim();

    // Multi-line string / array continuation.
    if (needsContinuation(valueText)) {
      const collected = [valueText];
      while (needsContinuation(collected.join('\n')) && n + 1 < lines.length) {
        n += 1;
        collected.push(lines[n]!);
      }
      valueText = collected.join('\n');
    }

    const target = descend(current, keyPath.slice(0, -1), lineNo);
    const last = keyPath.at(-1)!;
    if (last in target) {
      throw new TomlParseError(`duplicate key ${[...currentPath, ...keyPath].join('.')}`, lineNo);
    }
    target[last] = parseValue(valueText.trim(), lineNo);
  }

  void arrayTables;
  return root;
}

function needsContinuation(text: string): boolean {
  if (text.startsWith('"""')) return !(text.length >= 6 && text.endsWith('"""'));
  if (text.startsWith("'''")) return !(text.length >= 6 && text.endsWith("'''"));
  if (text.startsWith('[')) {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]!;
      if (inStr) {
        if (c === '\\') i += 1;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'") inStr = c;
      else if (c === '[') depth += 1;
      else if (c === ']') depth -= 1;
    }
    return depth > 0;
  }
  return false;
}

function stripComment(line: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (inStr) {
      if (c === '\\' && inStr === '"') i += 1;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function findAssignment(line: string): number {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (inStr) {
      if (c === '\\' && inStr === '"') i += 1;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '=') return i;
  }
  return -1;
}

function parseKeyPath(text: string, lineNo: number): string[] {
  const parts: string[] = [];
  let buf = '';
  let inStr: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (inStr) {
      if (c === inStr) {
        inStr = null;
        continue;
      }
      buf += c;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '.') {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  parts.push(buf.trim());

  const cleaned = parts.filter((p) => p !== '');
  if (cleaned.length === 0) throw new TomlParseError('empty key', lineNo);
  for (const p of cleaned) {
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') {
      throw new TomlParseError(`refusing unsafe key "${p}"`, lineNo);
    }
  }
  return cleaned;
}

function descend(table: TomlTable, keyPath: readonly string[], lineNo: number): TomlTable {
  let node = table;
  for (const key of keyPath) {
    let next = node[key];
    if (Array.isArray(next)) {
      const last = next.at(-1);
      if (typeof last !== 'object' || last === null || Array.isArray(last)) {
        throw new TomlParseError(`cannot descend into ${key}`, lineNo);
      }
      node = last as TomlTable;
      continue;
    }
    if (next === undefined) {
      next = {};
      node[key] = next;
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new TomlParseError(`cannot descend into ${key}`, lineNo);
    }
    node = next as TomlTable;
  }
  return node;
}

function parseValue(text: string, lineNo: number): TomlValue {
  if (text === '') throw new TomlParseError('missing value', lineNo);

  if (text.startsWith('"""')) return unescapeBasic(trimMultiline(text.slice(3, -3)), lineNo);
  if (text.startsWith("'''")) return trimMultiline(text.slice(3, -3));
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new TomlParseError('unterminated string', lineNo);
    return unescapeBasic(text.slice(1, -1), lineNo);
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new TomlParseError('unterminated string', lineNo);
    return text.slice(1, -1);
  }

  if (text === 'true') return true;
  if (text === 'false') return false;

  if (text.startsWith('[')) return parseArray(text, lineNo);
  if (text.startsWith('{')) return parseInlineTable(text, lineNo);

  const numeric = text.replace(/_/g, '');
  if (/^[+-]?\d+$/.test(numeric)) return Number.parseInt(numeric, 10);
  if (/^0x[0-9a-fA-F]+$/.test(numeric)) return Number.parseInt(numeric.slice(2), 16);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(numeric)) return Number.parseFloat(numeric);
  if (/^[+-]?(inf|nan)$/.test(numeric))
    return numeric.includes('nan') ? Number.NaN : numeric.startsWith('-') ? -Infinity : Infinity;

  // Dates and anything else are kept verbatim as strings.
  return text;
}

function trimMultiline(s: string): string {
  return s.startsWith('\n') ? s.slice(1) : s.startsWith('\r\n') ? s.slice(2) : s;
}

function unescapeBasic(s: string, lineNo: number): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, esc: string) => {
    switch (esc[0]) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'u':
      case 'U':
        return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
      case '\n':
        return '';
      default:
        throw new TomlParseError(`unknown escape \\${esc}`, lineNo);
    }
  });
}

function parseArray(text: string, lineNo: number): TomlValue[] {
  const inner = text.slice(1, text.lastIndexOf(']'));
  const items = splitTopLevel(inner, ',');
  return items
    .map((s) => stripComment(s).trim())
    .filter((s) => s !== '')
    .map((s) => parseValue(s, lineNo));
}

function parseInlineTable(text: string, lineNo: number): TomlTable {
  const inner = text.slice(1, text.lastIndexOf('}'));
  const out: TomlTable = {};
  for (const part of splitTopLevel(inner, ',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const eq = findAssignment(trimmed);
    if (eq < 0) throw new TomlParseError('expected key = value in inline table', lineNo);
    const keyPath = parseKeyPath(trimmed.slice(0, eq), lineNo);
    const target = descend(out, keyPath.slice(0, -1), lineNo);
    target[keyPath.at(-1)!] = parseValue(trimmed.slice(eq + 1).trim(), lineNo);
  }
  return out;
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let buf = '';

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (inStr) {
      buf += c;
      if (c === '\\' && inStr === '"') {
        buf += text[i + 1] ?? '';
        i += 1;
      } else if (c === inStr) {
        inStr = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      buf += c;
      continue;
    }
    if (c === '[' || c === '{') depth += 1;
    if (c === ']' || c === '}') depth -= 1;
    if (c === sep && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}
