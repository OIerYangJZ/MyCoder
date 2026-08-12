/**
 * YAML-ish frontmatter parser for `SKILL.md` and agent definition files.
 *
 * Deliberately a strict subset: scalars, inline arrays, and block sequences of
 * scalars. Skills and agents are untrusted project content — a full YAML parser
 * would add anchors, merge keys and tag resolution, none of which we need and
 * all of which have been sources of surprise. Anything we do not understand is
 * reported as an error, not silently ignored, because a misparsed
 * `permission_profile` is a security-relevant failure.
 */

export interface Frontmatter {
  attributes: Record<string, string | string[] | number | boolean>;
  body: string;
  errors: string[];
}

const DELIM = /^---[ \t]*$/;

export function parseFrontmatter(source: string): Frontmatter {
  const errors: string[] = [];
  const normalized = source.replace(/^﻿/, '');
  const lines = normalized.split(/\r?\n/);

  if (lines.length === 0 || !DELIM.test(lines[0] ?? '')) {
    return { attributes: {}, body: normalized, errors };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (DELIM.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return { attributes: {}, body: normalized, errors: ['unterminated frontmatter block'] };
  }

  const attributes: Record<string, string | string[] | number | boolean> = {};
  let pendingKey: string | null = null;
  let pendingList: string[] = [];

  const flush = (): void => {
    if (pendingKey !== null) {
      attributes[pendingKey] = pendingList;
      pendingKey = null;
      pendingList = [];
    }
  };

  for (let i = 1; i < end; i += 1) {
    const raw = lines[i]!;
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    const listItem = /^[ \t]+-[ \t]+(.*)$/.exec(raw) ?? /^-[ \t]+(.*)$/.exec(raw);
    if (listItem && pendingKey !== null) {
      pendingList.push(unquote(listItem[1]!.trim()));
      continue;
    }

    const kv = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(raw);
    if (!kv) {
      errors.push(`unparsable frontmatter line ${i + 1}: ${raw.trim().slice(0, 80)}`);
      continue;
    }

    flush();
    const key = kv[1]!;
    const value = kv[2]!.trim();

    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      errors.push(`refusing unsafe frontmatter key "${key}"`);
      continue;
    }

    if (value === '') {
      pendingKey = key;
      pendingList = [];
      continue;
    }

    attributes[key] = parseScalar(value);
  }
  flush();

  return { attributes, body: lines.slice(end + 1).join('\n'), errors };
}

function parseScalar(value: string): string | string[] | number | boolean {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => unquote(s.trim()));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
  return unquote(value);
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Coerce a frontmatter attribute to a string list, tolerating a single scalar. */
export function asStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '') return [value];
  return undefined;
}
