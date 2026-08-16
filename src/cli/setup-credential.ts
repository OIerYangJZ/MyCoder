/**
 * `mycoder setup-credential <path>` — write a key the kernel will accept (§11).
 *
 *     printf %s "$YOUR_API_KEY" | mycoder setup-credential ~/.config/mycoder/secrets/x.key
 *
 * §11's four prohibitions, and how each is met structurally rather than by care:
 *
 *   never write into a world-readable file
 *       `open(..., 'wx', 0o600)`. `mode` is masked by umask, and masking can only
 *       *remove* bits, so the result is 0600 or stricter on every umask. Then the
 *       file is re-checked with `checkCredentialFile` — the same function the
 *       kernel uses at startup — and removed again if that refuses it.
 *
 *   never echo it
 *       The value is read from stdin, and **only** from a pipe. If stdin is a
 *       terminal this refuses and prints the pipe form instead. That is a
 *       deliberate ergonomic cost: reading from a TTY means either echoing the
 *       key or driving raw mode correctly on every terminal, and the second is a
 *       thing to get subtly wrong on somebody's machine with their real
 *       credential on the screen. Refusing has no such failure mode. The value
 *       also never appears in argv, so it is not in `ps` output.
 *
 *   never place it inside the workspace
 *       `checkCredentialFile` refuses that, and this refuses *before* writing so
 *       the key is never briefly on disk in the wrong place.
 *
 *   never store it in the session store
 *       Nothing here touches a session. This command does not build a kernel.
 *
 * The last rule is §11's own: **a setup flow that produces a file the kernel then
 * rejects is worse than no setup flow.** So this ends by running the kernel's own
 * acceptance check, and treats a rejection as a failure of *this command* — it
 * unlinks what it wrote rather than leaving a credential the kernel will not use
 * sitting on disk.
 */

import { open, unlink } from 'node:fs/promises';
import * as path from 'node:path';

import { checkCredentialFile } from '../security/credential-file.ts';
import { canonicalize, type CanonicalPath } from '../util/paths.ts';
import { EXIT, type ExitCode } from './exit-codes.ts';

export interface SetupCredentialOptions {
  target: string;
  /** Where a relative path is anchored: the user config directory. */
  configDir: string;
  workspaceRoot: CanonicalPath;
  /** Reads the secret. Injected so the test never needs a real pipe. */
  readSecret: () => Promise<string>;
  stdinIsTty: boolean;
  force?: boolean;
}

export interface SetupResult {
  exit: ExitCode;
  message: string;
}

export async function setupCredential(opts: SetupCredentialOptions): Promise<SetupResult> {
  if (opts.stdinIsTty) {
    return {
      exit: EXIT.USAGE,
      message: [
        'setup-credential reads the key from stdin, never from the terminal.',
        '',
        'Typing it would either echo it to your screen or need raw-mode handling that can',
        'fail differently on every terminal — with your real credential on display when it',
        'does. Pipe it instead:',
        '',
        `    printf %s "$YOUR_API_KEY" | mycoder setup-credential ${opts.target}`,
        '',
        'Note the leading space if your shell has HISTCONTROL=ignorespace, or read the key',
        'from a password manager: `op read op://vault/item/key | mycoder setup-credential …`',
        '',
      ].join('\n'),
    };
  }

  const secret = (await opts.readSecret()).trim();
  if (secret === '') {
    return { exit: EXIT.USAGE, message: 'Nothing arrived on stdin, so there is no credential to write.\n' };
  }

  // Canonicalise the *parent* and rejoin the basename, rather than
  // canonicalising the whole path with `resolveSymlinks: false`.
  //
  // This is not tidying. The first version compared a canonical workspace root
  // against a lexical target, so on macOS — where /tmp is a symlink to
  // /private/tmp — `/tmp/ws/leak.key` did not look like it was inside
  // `/private/tmp/ws`, the pre-write check passed, and the key was written into
  // the workspace and only then removed by the post-write check. The comment
  // below is the reason that is not good enough.
  //
  // The parent is resolved (so containment is asked about the real location) and
  // the final component is not (so it is still the file we are about to create,
  // not something a link points at).
  const parent = (await canonicalize(path.dirname(opts.target), { cwd: opts.configDir })).path;
  const target = path.join(parent, path.basename(opts.target));
  const configDir = (await canonicalize(opts.configDir, { cwd: opts.configDir })).path;

  // Refuse *before* writing. The point of checking the location first is that a
  // key written into a repository and deleted a millisecond later has still been
  // in a repository — and on a filesystem with snapshots or an editor watching
  // the tree, "briefly" is not a guarantee of anything.
  if (isWithinDir(opts.workspaceRoot, target)) {
    return {
      exit: EXIT.CONFIG,
      message:
        `Refusing to write ${target}: it is inside the workspace.\n\n` +
        'A credential there is one `git add` from being committed and one Read from being in\n' +
        "the model's context. Put it under your config directory instead:\n\n" +
        `    ${path.join(opts.configDir, 'secrets', path.basename(target))}\n`,
    };
  }

  let handle;
  try {
    // 'wx' — exclusive create. An existing key is never silently overwritten:
    // clobbering the credential that currently works, with one that may not, is
    // the kind of data loss that is only discovered at the next request.
    handle = await open(target, opts.force ? 'w' : 'wx', 0o600);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      return {
        exit: EXIT.CONFIG,
        message:
          `${target} already exists and was not touched.\n\n` +
          'Re-run with --force to replace it, or delete it first. Overwriting a working\n' +
          'credential with an untested one fails at the next request, not now.\n',
      };
    }
    if (err.code === 'ENOENT') {
      return {
        exit: EXIT.CONFIG,
        message: `${path.dirname(target)} does not exist.\n\n    mkdir -p ${path.dirname(target)}\n`,
      };
    }
    return { exit: EXIT.CONFIG, message: `Could not write ${target}: ${err.message}\n` };
  }

  try {
    await handle.writeFile(secret, 'utf8');
    // Explicit chmod after the write: `open`'s mode applies only when the file is
    // *created*, so under --force an existing 0644 file would keep its mode and
    // this command would have produced exactly the world-readable credential §11
    // forbids.
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }

  // §11's own rule, executed: verify with the function the kernel will use, and
  // treat a rejection as this command's failure rather than the user's problem.
  try {
    const info = await checkCredentialFile(target, {
      cwd: configDir,
      workspaceRoot: opts.workspaceRoot,
    });
    // Relative when it stays under the config directory — which is what
    // `api_key_file` is anchored to — and absolute otherwise. A `../../..` path
    // is technically correct and nobody would paste it.
    const relative = path.relative(configDir, info.path);
    const suggestion = relative !== '' && !relative.startsWith('..') ? relative : info.path;
    return {
      exit: EXIT.OK,
      message:
        `Wrote ${info.path}${info.mode !== undefined ? ` (mode 0${info.mode.toString(8)})` : ''}.\n` +
        'The kernel accepts it. Point a provider at it with:\n\n' +
        `    api_key_file = "${suggestion}"\n\n` +
        'Then check the whole setup with `mycoder doctor`.\n',
    };
  } catch (e) {
    await unlink(target).catch(() => {});
    const err = e as { kernelError?: { message: string } };
    return {
      exit: EXIT.CONFIG,
      message:
        `Wrote ${target}, then removed it again: the kernel would not accept it.\n\n` +
        `    ${err.kernelError?.message ?? String(e)}\n\n` +
        'Leaving a credential on disk that the kernel refuses to read would be worse than\n' +
        'not writing one, so nothing remains.\n',
    };
  }
}

function isWithinDir(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
