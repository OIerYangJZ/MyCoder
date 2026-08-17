/**
 * Credential file source (alpha.3 §5–§8).
 *
 * The one remaining reason a user had to `export PROVIDER_API_KEY=...` in every
 * terminal was that the SecretBroker's `file` source had no way to be
 * *configured*. This module is that entry point, and it is deliberately more
 * than a path string: a credential store the agent itself can read defeats the
 * purpose, so validating the file and registering it as a protected path are the
 * same operation. There is no way to configure one without the other.
 *
 * What is checked, and why each one is not merely hygiene:
 *
 *   regular file          a FIFO turns a credential read into an unbounded
 *                         blocking read inside the model request path;
 *                         a directory read returns EISDIR at the worst moment
 *   not a symlink         the link target is what actually holds the bytes, and
 *                         its mode is what actually matters — following one
 *                         would validate the wrong inode. Rejected rather than
 *                         followed, so the file that is checked is the file that
 *                         is read
 *   mode 0600 or stricter group/other bits mean another local account already
 *                         has the credential
 *   owned by this user    a file someone else owns is a file someone else can
 *                         rewrite, and the value would then be *theirs*
 *   outside the workspace a key inside the repository is one `git add` from
 *                         being published, and one Read from being in context
 *   outside reference     same, for the read-only reference trees
 *
 * Windows has no POSIX mode bits to check, so the permission test is skipped
 * there and `mode` comes back undefined. That is a real gap, recorded in the
 * threat model rather than papered over with a check that always passes.
 *
 * The kernel never repairs the file. `chmod 0600` on a path the user chose is an
 * unrequested modification of something outside the workspace, and a tool that
 * silently fixes a permission problem trains people not to look at it.
 */

import { lstat, stat } from 'node:fs/promises';

import { kernelError, KernelErrorException, type KernelError } from '../util/errors.ts';
import { canonicalize, isWithin, type CanonicalPath } from '../util/paths.ts';

/** Modes with any group or other bit set. 0o077 is the complement of 0o700. */
const GROUP_OTHER_BITS = 0o077;

export interface CredentialFileCheckOptions {
  /**
   * Anchor for a relative path, and the base for `~` expansion.
   *
   * Callers pass the **user config directory**, not the workspace. A relative
   * `api_key_file` is relative to the file that declares it, which is the only
   * anchor that cannot silently place the credential somewhere it would then be
   * refused: anchoring to the workspace would make the natural-looking
   * `api_key_file = "secrets/provider.key"` resolve inside the repository and
   * be rejected for being there.
   */
  cwd: string;
  home?: string;
  /** A credential inside the workspace is refused: see the header. */
  workspaceRoot?: CanonicalPath;
  referenceRoots?: readonly CanonicalPath[];
  /** True on platforms with no POSIX mode bits. Defaults to `win32`. */
  skipModeCheck?: boolean;
}

export interface CredentialFileInfo {
  /** Canonical path, which is what gets registered as protected. */
  path: CanonicalPath;
  /** POSIX permission bits, or undefined where the platform has none. */
  mode?: number;
}

/**
 * Validate a configured credential file.
 *
 * Returns the canonical path on success and throws `CREDENTIAL_FILE_INSECURE`
 * with a `safeDetails.problem` naming the specific defect on failure. The
 * message names the path because the user is the one who has to fix it and this
 * error never reaches the model — `describeCredentialSource` is what `/status`
 * shows.
 */
export async function checkCredentialFile(
  configured: string,
  opts: CredentialFileCheckOptions,
): Promise<CredentialFileInfo> {
  const skipMode = opts.skipModeCheck ?? process.platform === 'win32';

  // Two resolutions, in this order, because §6 asks for two things that pull
  // against each other: "canonicalized before validation" and "not symlink".
  //
  // The *lexical* form comes first — absolute, `~` expanded, `..` collapsed,
  // but with the final component left alone. That is the only form in which
  // "is the configured path itself a symlink?" is still an answerable
  // question; canonicalising first would have followed the link and left us
  // validating the target while the link is what gets read next time.
  const lexical = (
    await canonicalize(configured, {
      cwd: opts.cwd,
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      resolveSymlinks: false,
    })
  ).path;

  // `lstat`, not `stat`: the question is whether *this* path is a symlink, and
  // `stat` would answer for the target and hide the redirection.
  let link;
  try {
    link = await lstat(lexical);
  } catch {
    throw insecure(lexical, 'missing', 'does not exist or could not be read');
  }

  if (link.isSymbolicLink()) {
    throw insecure(
      lexical,
      'symlink',
      'is a symbolic link. Point api_key_file at the real file: a link can be repointed by anything ' +
        'that can write its directory, so checking it once says nothing about what is read later',
    );
  }
  if (link.isDirectory()) throw insecure(lexical, 'directory', 'is a directory');
  if (link.isFIFO()) throw insecure(lexical, 'fifo', 'is a FIFO');
  if (link.isSocket()) throw insecure(lexical, 'socket', 'is a socket');
  if (!link.isFile()) throw insecure(lexical, 'not-regular-file', 'is not a regular file');

  // Now the full canonical form. The final component is not a link, but a
  // *parent* directory may be, and the protected-path set has to hold the path
  // the policy engine will actually be asked about — which is canonical.
  const target = (
    await canonicalize(configured, {
      cwd: opts.cwd,
      ...(opts.home !== undefined ? { home: opts.home } : {}),
    })
  ).path;

  if (opts.workspaceRoot && isWithin(opts.workspaceRoot, target)) {
    // Two different situations reach this line, and telling the user to do the
    // same thing in both sends half of them the wrong way.
    //
    // The ordinary one is a credential sitting in a project: move it out, which
    // is what the message has always said.
    //
    // The other one is a **workspace so broad that it contains the config
    // directory** — running `mycoder` from `$HOME` is enough. Then the credential
    // is exactly where it belongs, `~/.config/mycoder/secrets/`, and the thing
    // that is wrong is the workspace. "Move it outside the repository" is not just
    // unhelpful there: following it moves a correctly-placed key somewhere worse.
    //
    // Found on a fresh Linux install by running `mycoder` in the home directory,
    // which is the first thing anybody does.
    const configDir = (
      await canonicalize(opts.cwd, {
        cwd: opts.cwd,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      })
    ).path;

    if (isWithin(opts.workspaceRoot, configDir) && isWithin(configDir, target)) {
      throw insecure(
        target,
        'workspace-contains-config',
        `is inside the workspace, because the workspace is ${opts.workspaceRoot}, which contains ` +
          `your config directory ${configDir}. The credential is in the right place; the workspace ` +
          'is not. Run from the project directory you mean, or pass `--cwd <project>` — there is no ' +
          'need to move the credential',
      );
    }

    throw insecure(
      target,
      'inside-workspace',
      'is inside the workspace. A credential there is one `git add` from being committed and ' +
        "one Read from being in the model's context. Move it outside the repository",
    );
  }
  for (const root of opts.referenceRoots ?? []) {
    if (isWithin(root, target)) {
      throw insecure(target, 'inside-reference-tree', 'is inside a reference repository');
    }
  }

  const info: CredentialFileInfo = { path: target };

  if (!skipMode) {
    // `stat` here rather than reusing `link`: identical for a regular
    // non-symlink, and it keeps the mode reading independent of the type check
    // above rather than depending on it having already run.
    const st = await stat(target);
    const mode = st.mode & 0o777;
    info.mode = mode;

    if ((mode & GROUP_OTHER_BITS) !== 0) {
      throw insecure(
        target,
        'permissive-mode',
        `has mode ${formatMode(mode)}; it must be 0600 or stricter. Run: chmod 600 ${target}`,
        { mode: formatMode(mode) },
      );
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw insecure(
        target,
        'foreign-owner',
        'is owned by another user, who can therefore replace the credential it supplies',
      );
    }
  }

  return info;
}

/**
 * Where a provider's credential comes from, in the order it is consulted (§5).
 *
 * `session` is an explicit CLI or session-level override, which wins so a user
 * can point one run at a different key without editing a file. `file` beats
 * `env` because it is the persistent, permission-checked source — if both are
 * configured, the one with a security property attached should be the one that
 * takes effect, and the other is reported as unused rather than silently
 * shadowing it.
 */
export type CredentialSourceKind = 'session' | 'file' | 'env' | 'none';

export interface CredentialSourceInputs {
  sessionOverride?: string;
  apiKeyFile?: string;
  apiKeyEnv?: string;
}

export interface CredentialSourceChoice {
  kind: CredentialSourceKind;
  /** The file path or environment variable name that was selected. */
  selector?: string;
  /** Sources that were configured but lost the precedence contest. */
  shadowed: Array<{ kind: CredentialSourceKind; selector: string }>;
}

/** Apply the §5 precedence. Pure, so the ordering is testable on its own. */
export function chooseCredentialSource(inputs: CredentialSourceInputs): CredentialSourceChoice {
  const candidates: Array<{ kind: CredentialSourceKind; selector: string }> = [];
  if (inputs.sessionOverride) candidates.push({ kind: 'session', selector: inputs.sessionOverride });
  if (inputs.apiKeyFile) candidates.push({ kind: 'file', selector: inputs.apiKeyFile });
  if (inputs.apiKeyEnv) candidates.push({ kind: 'env', selector: inputs.apiKeyEnv });

  const winner = candidates[0];
  if (!winner) return { kind: 'none', shadowed: [] };
  return { kind: winner.kind, selector: winner.selector, shadowed: candidates.slice(1) };
}

/**
 * The `/status` line for a credential (§8).
 *
 * Reports the *source*, never the value, and never the fingerprint either — a
 * fingerprint is safe to log but is not something a status screen needs, and
 * every additional derived form is another thing to keep out of a screenshot.
 */
export function describeCredentialSource(choice: CredentialSourceChoice, configured: boolean): string {
  switch (choice.kind) {
    case 'file':
      return `credential source: file · credential configured: ${configured ? 'yes' : 'no'}`;
    case 'env':
      return `credential source: environment (${choice.selector}) · credential configured: ${configured ? 'yes' : 'no'}`;
    case 'session':
      return `credential source: session override · credential configured: ${configured ? 'yes' : 'no'}`;
    case 'none':
      return 'credential source: none · credential configured: no';
  }
}

function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

function insecure(
  path: CanonicalPath,
  problem: string,
  detail: string,
  extra: Record<string, unknown> = {},
): KernelErrorException {
  return new KernelErrorException(credentialFileError(path, problem, detail, extra));
}

export function credentialFileError(
  path: CanonicalPath,
  problem: string,
  detail: string,
  extra: Record<string, unknown> = {},
): KernelError {
  return kernelError('CREDENTIAL_FILE_INSECURE', `The credential file ${path} ${detail}.`, {
    blame: 'user',
    retryable: false,
    // The path is safe here and useful: this error is shown to the *user* at
    // startup, not handed to the model. It never enters a tool result.
    safeDetails: { problem, path, ...extra },
  });
}
