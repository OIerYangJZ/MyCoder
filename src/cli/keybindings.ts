/**
 * Keys the user can move.
 *
 * The editor's own table is what a terminal sends by default; this lets somebody who
 * has spent a decade in emacs or vi bind what their hands already do. A JSON file in
 * the config directory, read once at startup:
 *
 * ```json
 * { "ctrl+p": "up", "ctrl+n": "down", "ctrl+s": "search" }
 * ```
 *
 * **A bad file is a warning, not a failure.** A syntax error in a keybindings file
 * should not stop a session starting — the same rule the config parser follows. An
 * unknown key name or an unknown action is reported by name and skipped, because the
 * silent version of that is a binding somebody swears they wrote and cannot find.
 *
 * **Nothing here can bind a key that does something the editor cannot already do.**
 * The value must name one of the editor's existing actions, so a keybindings file is
 * a remapping and never a capability.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { Key } from './editor.ts';

/** The actions a binding may name — every editor key that takes no payload. */
const ACTIONS = [
  'enter',
  'newline',
  'backspace',
  'delete',
  'left',
  'right',
  'up',
  'down',
  'home',
  'end',
  'word-left',
  'word-right',
  'kill-to-end',
  'kill-to-start',
  'kill-word',
  'yank',
  'tab',
  'cancel',
  'eof',
  'escape',
  'clear',
  'undo',
  'redo',
  'search',
  // Shift-Tab's action, bindable because Shift-Tab is not reachable in every
  // terminal — tmux with a stale terminfo swallows it, and some remote consoles
  // never send `CSI Z`. Binding it to a control key is then the difference
  // between having the feature and not. Still not a capability: the action
  // already exists and cycles a mode the user can reach with `/mode`.
  'cycle-mode',
] as const;

type Action = (typeof ACTIONS)[number];

const isAction = (value: unknown): value is Action =>
  typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);

/**
 * `ctrl+a` … `ctrl+z` to their control byte.
 *
 * Only the control range is bindable. A printable key is text — binding `k` to
 * `up` would make the letter untypeable, which is a foot-gun rather than a feature.
 */
export function controlByteFor(name: string): number | undefined {
  const match = /^ctrl\+([a-z])$/.exec(name.trim().toLowerCase());
  if (!match) return undefined;
  const letter = match[1] ?? '';
  return letter.charCodeAt(0) - 96;
}

export interface Keybindings {
  /** Control byte → action, overriding the editor's defaults. */
  overrides: ReadonlyMap<number, Key>;
  /** Problems worth telling the user about, in the words they used. */
  warnings: readonly string[];
}

export const NO_KEYBINDINGS: Keybindings = { overrides: new Map(), warnings: [] };

export function keybindingsPath(configDir: string): string {
  return path.join(configDir, 'keybindings.json');
}

/** Read and validate. A missing file is the normal case and says nothing. */
export async function loadKeybindings(configDir: string): Promise<Keybindings> {
  let raw: string;
  try {
    raw = await readFile(keybindingsPath(configDir), 'utf8');
  } catch {
    return NO_KEYBINDINGS;
  }
  return parseKeybindings(raw, keybindingsPath(configDir));
}

/** Separated from the read so the validation can be tested without a file. */
export function parseKeybindings(raw: string, where: string): Keybindings {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      overrides: new Map(),
      warnings: [`${where} is not valid JSON and was ignored: ${(e as Error).message}`],
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { overrides: new Map(), warnings: [`${where} should be an object of key → action`] };
  }

  const overrides = new Map<number, Key>();
  for (const [name, action] of Object.entries(parsed as Record<string, unknown>)) {
    const byte = controlByteFor(name);
    if (byte === undefined) {
      warnings.push(`${where}: "${name}" is not a bindable key (use ctrl+a … ctrl+z)`);
      continue;
    }
    if (!isAction(action)) {
      warnings.push(`${where}: "${String(action)}" is not an action this editor has`);
      continue;
    }
    overrides.set(byte, { kind: action } as Key);
  }
  return { overrides, warnings };
}
