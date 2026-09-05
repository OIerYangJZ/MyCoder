#!/usr/bin/env node
/**
 * CLI entry point (spec §15, ADR-0021).
 *
 * Deliberately thin: parse flags, build the kernel, then loop over input,
 * dispatching each line either to the control plane (if it starts with `/`) or
 * to the agent loop. Everything interesting happens behind `createKernel`.
 *
 * A raw shell line typed by the user is parsed into argv before it can reach the
 * Shell tool (§9.2), which is why `parseShellLine` is imported here and not
 * inside the tool.
 *
 * Two alpha.8 changes are worth knowing about before reading:
 *
 *   **Exit codes are a contract** (ADR-0021). Every `return` below is a named
 *   constant from `exit-codes.ts`, and every error path maps through
 *   `exitCodeForError` so that a wrapper script can tell "your config is wrong"
 *   from "the model gave up" without parsing English.
 *
 *   **The diagnostics do not build a kernel.** `doctor`, `--print-config`,
 *   `--sandbox-status` and `build-sandbox` are answered before `createKernel`,
 *   because each of them is asked precisely when the kernel will not start.
 */

import * as readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';

import { createKernel, KERNEL_VERSION, type Kernel } from '../kernel.ts';
import {
  findMostRecentSession,
  listResumableSessions,
  describeResume,
  replaySession,
} from '../session/resume.ts';
import { FileSessionStore } from '../session/store.ts';
import { Redactor } from '../security/redactor.ts';
import { resolveKernelDirs, sessionsDir } from '../util/platform.ts';
import { toKernelError, type ErrorCode } from '../util/errors.ts';
import type { SessionId } from '../util/ids.ts';
import { canonicalize } from '../util/paths.ts';
import { describeEnforcement, networkEnforcementLabel, withForeignTools } from '../execution/enforcement.ts';
import { checkWorkspaceRoot } from '../config/first-run.ts';
import type { LogLevel } from '../util/logger.ts';
import { buildSandbox } from '../execution/linux-native/build.ts';
import { verifyLauncher, describeLauncher } from '../execution/linux-native/identity.ts';
import { resolveLauncherPath, resolveLauncherSourcePath } from '../execution/linux-native/paths.ts';
import { parseArgs, USAGE } from './args.ts';
import { EXIT, exitCodeForError, exitCodeForTurn, type ExitCode } from './exit-codes.ts';
import { runDoctor, printConfig } from './doctor.ts';
import { setupCredential } from './setup-credential.ts';
import { TerminalApprovalPrompter } from './prompter.ts';
import {
  banner,
  colourDepth,
  colourEnabled,
  glyphs as glyphSet,
  inputFrame,
  modeIndicator,
  palette as makePalette,
  sessionList,
  SessionRenderer,
  statusLine,
  submitted,
} from './render.ts';
import { describeApprovalMode } from '../policy/approval-mode.ts';
import { applyApprovalMode } from '../control/control-plane.ts';
import { Editor } from './editor.ts';
import { FileIndex, mutationChangesPaths, resolveReferences } from './completions.ts';
import { loadKeybindings } from './keybindings.ts';
import { sanitiseModelText } from './markdown.ts';
import { parseShellLine, describePlan } from './shell-parse.ts';

/** The `--json` envelope. One object per line on stdout, nothing else. */
const SCHEMA = 'mycoder.v1';

function emit(payload: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify({ schema: SCHEMA, ...payload })}\n`);
}

/**
 * Report a failure in whichever form the caller asked for.
 *
 * Under `--json` an error is a JSON object, not English on stderr: a run that
 * failed by writing prose would force the wrapper back to parsing prose for
 * exactly the cases it most needs to distinguish (ADR-0021 §3).
 */
function fail(json: boolean, code: ErrorCode, message: string, remedy?: string): ExitCode {
  const exit = exitCodeForError(code);
  if (json) {
    emit({ type: 'error', code, exit, message, ...(remedy ? { remedy } : {}) });
  } else {
    stderr.write(`${code}: ${message}\n`);
    if (remedy) stderr.write(`\n${remedy}\n`);
  }
  return exit;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    stdout.write(USAGE);
    return EXIT.OK;
  }
  if (args.version) {
    if (args.json) emit({ type: 'version', version: KERNEL_VERSION });
    else stdout.write(`${KERNEL_VERSION}\n`);
    return EXIT.OK;
  }
  if (args.errors.length > 0) {
    for (const error of args.errors) stderr.write(`error: ${error}\n`);
    stderr.write('\nRun `mycoder --help` for usage.\n');
    return EXIT.USAGE;
  }

  const dirs = resolveKernelDirs();
  const cwd = args.cwd ?? process.cwd();

  // --- diagnostics and setup, none of which build a kernel -------------------

  if (args.command === 'doctor') {
    const { report, text } = await runDoctor({ workspaceDir: cwd, json: args.json });
    stdout.write(text);
    return report.exit;
  }

  if (args.printConfig) {
    const { text, exit } = await printConfig({
      workspaceDir: cwd,
      flags: {
        ...(args.profile ? { profile: args.profile } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.noTelemetry ? { telemetryDisabled: true } : {}),
      },
    });
    stdout.write(text);
    return exit;
  }

  if (args.command === 'build-sandbox') {
    const result = buildSandbox({ kernelVersion: KERNEL_VERSION });
    stdout.write(`${result.detail}\n`);
    if (result.remedy) stdout.write(`\n${result.remedy}\n`);
    return result.ok ? EXIT.OK : EXIT.UNAVAILABLE;
  }

  if (args.sandboxStatus) {
    const source = resolveLauncherSourcePath();
    const verdict = verifyLauncher(resolveLauncherPath(), source);
    if (args.json) {
      emit({
        type: 'sandbox-status',
        ok: verdict.ok,
        binary: verdict.binary,
        source,
        ...(verdict.ok
          ? { manifest: verdict.manifest }
          : { problem: verdict.problem, reason: verdict.reason, remedy: verdict.remedy }),
      });
    } else {
      stdout.write(`${describeLauncher(verdict, source)}\n`);
    }
    return verdict.ok ? EXIT.OK : EXIT.UNAVAILABLE;
  }

  if (args.command === 'setup-credential') {
    if (!args.commandArg) {
      stderr.write('setup-credential needs a path to write.\n\n  mycoder setup-credential <path>\n');
      return EXIT.USAGE;
    }
    const result = await setupCredential({
      target: args.commandArg,
      configDir: dirs.config,
      workspaceRoot: (await canonicalize(cwd, { cwd: process.cwd() })).path,
      stdinIsTty: stdin.isTTY === true,
      force: args.force,
      readSecret: () => readAllStdin(),
    });
    (result.exit === EXIT.OK ? stdout : stderr).write(result.message);
    return result.exit;
  }

  // --- a real session --------------------------------------------------------

  // How this session will look, decided before anything is printed: the session
  // picker below is the first thing that writes, and it should not be the one
  // surface that ignores NO_COLOR. `live` is false for `--json` and for anything
  // that is not a terminal — stdout is a contract and a log file should not
  // receive spinner frames.
  // The terminal's width, re-read each time: a window can be resized mid-session.
  const columns = (): number => {
    // A pty with no window size reports 0, and `Math.max(8, 0 - 2)` produced an
    // eight-dash rule that looked like a bug in the frame rather than in the size.
    const reported = stderr.isTTY === true ? stderr.columns : undefined;
    return typeof reported === 'number' && reported > 20 ? reported : 80;
  };

  // The terminal height, for the same reason and with the same caution as the width:
  // a pty with no window size reports 0, and an editor that believed it would window
  // its completion menu down to nothing.
  const rows = (): number => {
    const reported = stderr.isTTY === true ? stderr.rows : undefined;
    return typeof reported === 'number' && reported > 4 ? reported : 24;
  };

  // lint-allow no-host-env-read: NO_COLOR / TERM / FORCE_COLOR / COLORTERM /
  // TERM_PROGRAM decide styling only. Nothing read here reaches a child process, the
  // model or a log, and no credential is spelled any of those names.
  const colour = colourEnabled(process.env, stderr.isTTY === true) && !args.json;
  const glyphs = glyphSet(colour);
  // How *much* colour, not just whether: the accent this program is drawn in has no
  // ANSI code, so a terminal that can show it is asked for it and one that cannot
  // gets the nearest thing the table has. `--json` still gets nothing at all.
  // lint-allow no-host-env-read: the same names again, on the same terms.
  const palette = makePalette(args.json ? false : colourDepth(process.env, stderr.isTTY === true));

  // The answer goes to stdout and the chrome goes to stderr, so styling is decided
  // twice. `mycoder … > answer.md` has a terminal on one and a file on the other,
  // and asking `stderr.isTTY` for both is how escape codes end up in the file.
  // lint-allow no-host-env-read: the same names, for the same reason, on the other
  // stream. Nothing read here leaves this expression.
  const answerColour = colourEnabled(process.env, stdout.isTTY === true) && !args.json;
  // lint-allow no-host-env-read: as above, and measured against stdout this time.
  const answerPalette = makePalette(args.json ? false : colourDepth(process.env, stdout.isTTY === true));

  // Resolve which session to use before building the kernel, so `-c` and `-r`
  // can be reported clearly rather than failing deep inside bootstrap.
  const workspacePath = (await canonicalize(cwd, { cwd: process.cwd() })).path;
  let resumeSessionId = args.resumeSessionId;
  if (args.continueSession && !resumeSessionId) {
    const probeStore = new FileSessionStore({ rootDir: sessionsDir(dirs), redactor: new Redactor() });
    // This workspace's most recent, not the machine's: a session from another
    // directory cannot be resumed into this one, and `-c` used to pick it anyway
    // and die on the identity check.
    const recent = await findMostRecentSession(probeStore, workspacePath);
    if (!recent) {
      stderr.write(`No previous session in ${workspacePath} to continue.\n`);
      return EXIT.INCOMPLETE;
    }
    resumeSessionId = recent.sessionId;
  } else if (args.resumePicker && !resumeSessionId) {
    // `-r` with no id (ADR-0029). Nobody remembers a session id, so the list is
    // keyed by what each session was asked to do.
    const probeStore = new FileSessionStore({ rootDir: sessionsDir(dirs), redactor: new Redactor() });
    const { sessions, elsewhere } = await listResumableSessions(probeStore, workspacePath);

    if (sessions.length === 0) {
      const others = elsewhere > 0 ? ` ${elsewhere} session(s) belong to other workspaces.` : '';
      if (args.json) {
        emit({ type: 'sessions', workspace: workspacePath, sessions: [], elsewhere });
        return EXIT.INCOMPLETE;
      }
      stderr.write(`No session in ${workspacePath} to resume.${others}\n`);
      return EXIT.INCOMPLETE;
    }

    const choices = sessions.map((s) => ({
      sessionId: s.sessionId,
      ...(s.title ? { title: s.title } : {}),
      model: s.model,
      updatedAt: s.updatedAt,
      toolCalls: s.usage.toolCalls,
    }));

    if (args.json) {
      // Machine-readable and then out: a picker needs a person, and a script that
      // wanted one session can read this list and pass `-r <id>`.
      emit({ type: 'sessions', workspace: workspacePath, sessions: choices, elsewhere });
      return EXIT.OK;
    }

    stderr.write(`${sessionList(choices, workspacePath, Date.now(), palette)}\n`);
    if (elsewhere > 0) {
      stderr.write(`\n${elsewhere} more session(s) belong to other workspaces and are not listed.\n`);
    }

    if (stdin.isTTY !== true) {
      // Nothing to prompt with. The list is still the answer to "which sessions
      // do I have", and naming the flag is cheaper than making them ask again.
      stderr.write(`\nResume one with: mycoder -r ${choices[0]!.sessionId}\n`);
      return EXIT.INCOMPLETE;
    }

    const picker = readline.createInterface({ input: stdin, output: stderr, terminal: true });
    // Ctrl+D closes the prompt rather than rejecting out of `main`: at a "which
    // one?" question, end-of-input means "none of them", and it used to arrive as
    // `failed to start: Aborted with Ctrl+D`.
    const answer = await picker
      .question(`\nResume which? [1-${choices.length}, Enter to cancel] `)
      .catch(() => '');
    picker.close();

    const index = Number.parseInt(answer.trim(), 10);
    if (!Number.isInteger(index) || index < 1 || index > choices.length) {
      stderr.write('Nothing was resumed.\n');
      return EXIT.INCOMPLETE;
    }
    resumeSessionId = choices[index - 1]!.sessionId;
  } else if (resumeSessionId) {
    // An id nothing was ever recorded under used to *become* the id of a brand
    // new session: `-r ses_typo` looked like a resume, said nothing, and started
    // from zero. Whatever the mistake was — a typo, the wrong machine, a purged
    // store — it is not "here is an empty conversation".
    const probeStore = new FileSessionStore({ rootDir: sessionsDir(dirs), redactor: new Redactor() });
    const known = await probeStore.loadMetadata(resumeSessionId as SessionId);
    if (!known) {
      stderr.write(
        `No session "${resumeSessionId}" was found under ${sessionsDir(dirs)}.\n` +
          'Run without -r to start a new one, or -c to continue the most recent.\n',
      );
      return EXIT.INCOMPLETE;
    }
  }

  // Only create a readline interface for a real terminal. Attaching one to a
  // pipe consumes the buffered lines before the async iterator is attached, and
  // they are then lost — so piped input is read directly instead.
  const interactive = stdin.isTTY === true;

  // The control-command list, filled in once the kernel exists. The line editor's
  // completion reads it; it is a holder rather than a value because the interface
  // below has to be built before `createKernel`, so that a failure during startup
  // can still be reported to a terminal.
  let controlCommands: readonly string[] = [];

  // `readline` no longer reads the prompt — the editor does (ADR-0032). What is left
  // is the approval prompter's typed fallback, which needs an interface to ask on and
  // to pause while the arrow-key menu has the terminal. No `completer`: it was for the
  // prompt, and Tab-completing a slash command into a y/n answer completes nothing.
  const rl = interactive
    ? readline.createInterface({ input: stdin, output: stdout, terminal: true })
    : undefined;

  // Before anything is built: is this workspace one an agent should be pointed at?
  // (ADR-0028.) A workspace containing the config directory is a home directory
  // somebody ran the command in, and until alpha.12 it was refused only for people
  // whose credential happened to be a file — with a message that told them to move
  // a correctly-placed key. One refusal, one message, whatever the credential is.
  const workspaceVerdict = checkWorkspaceRoot(
    (await canonicalize(cwd, { cwd: process.cwd() })).path,
    (await canonicalize(dirs.config, { cwd: process.cwd() })).path,
  );
  if (!workspaceVerdict.ok) {
    rl?.close();
    return fail(
      args.json,
      'WORKSPACE_CONTAINS_CONFIG',
      `Refusing to start: ${workspaceVerdict.problem}`,
      workspaceVerdict.remedy,
    );
  }

  // The `@` index, built once the workspace root is known. Declared here because the
  // kernel is created before it and its event stream is what keeps the cache honest.
  let files: FileIndex | undefined;

  const renderer = new SessionRenderer({
    write: (t) => stderr.write(t),
    palette,
    glyphs,
    live: !args.json && stderr.isTTY === true,
    // Not under `--json`: a JSON envelope and a stream of prose cannot share a file
    // descriptor. Everywhere else the answer is streamed, pipes included — the bytes
    // are the same ones stdout was going to receive at the end of the turn.
    ...(args.json ? {} : { writeAnswer: (t: string) => stdout.write(t) }),
    answerPalette,
    answerIsTerminal: stdout.isTTY === true,
    columns,
    // Only where there is a handler to hear it. `cancelTurn` is installed on SIGINT
    // for the interactive loop and nowhere else, so a one-shot run must not offer a
    // key that would kill the process instead of cancelling the turn.
    ...(interactive ? { interruptHint: 'ctrl-c to interrupt' } : {}),
  });

  let kernel: Kernel;
  try {
    kernel = await createKernel({
      onEvent: (type, payload) => {
        renderer.on(type, payload);
        // A file the agent created should be offerable by the next Tab. Only when the
        // path set actually moved — an edit to an existing file leaves it alone, and
        // re-walking for that would cost a directory scan per edit.
        if (mutationChangesPaths(type, payload)) files?.invalidate();
      },
      workspaceDir: cwd,
      ...(args.profile ? { profileOverride: args.profile } : {}),
      ...(args.model ? { modelOverride: args.model } : {}),
      ...(args.remote ? { remoteName: args.remote } : {}),
      ...(args.backend ? { backend: args.backend } : {}),
      ...(args.noTelemetry ? { telemetryDisabled: true } : {}),
      ...(args.logLevel ? { logLevel: args.logLevel as LogLevel } : {}),
      json: args.json,
      verbose: args.verbose,
      nonInteractive: args.nonInteractive || !interactive,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(rl && !args.nonInteractive
        ? {
            prompter: new TerminalApprovalPrompter({
              rl,
              write: (t) => stderr.write(t),
              palette,
              glyphs,
              columns,
              // The spinner is running for the very tool call this prompt is about,
              // and it erases the line the answer is typed on.
              quiet: () => renderer.quiet(),
              // Arrow keys for the four answers. Only when there is a terminal to
              // press them on; a piped run falls back to typing a letter.
              ...(stdin.isTTY === true ? { keys: stdin } : {}),
            }),
          }
        : {}),
    });
  } catch (e) {
    rl?.close();
    // Startup failures are the ones a fresh install actually meets, so they get
    // the documented code and the remedy rather than `Failed to start: <text>`
    // and exit 1. `PROVIDER_NOT_CONFIGURED` reaching here is §10's second
    // outcome: blocked, with a remedy.
    const err = toKernelError(e);
    const remedy = typeof err.safeDetails?.remedy === 'string' ? err.safeDetails.remedy : undefined;
    return fail(args.json, err.code, err.message, remedy);
  }

  controlCommands = kernel.control.commandNames();

  for (const warning of kernel.config.warnings) {
    stderr.write(`warning: ${warning}\n`);
  }

  if (resumeSessionId) {
    const replayed = await replaySession(kernel.store, kernel.sessionId);
    if (replayed) {
      stderr.write(
        `${describeResume(replayed, {
          model: kernel.session.activeModelAlias,
          profile: kernel.config.security.permissionProfile ?? 'workspace-dev',
        })}\n`,
      );
    }
  }

  // The banner replaces a full `/status` dump at startup. `/status` still prints
  // everything — the dump was accurate and unreadable, and four lines of it are
  // what anybody actually checks before typing.
  if (!args.json) {
    // From the backend's own descriptor, via the same helper `/status` uses —
    // never a literal (invariant 5, and the `no-enforcement-overclaim` lint rule).
    const descriptor = withForeignTools(kernel.backend.environment.enforcement, []);
    const enforcement = describeEnforcement(descriptor);
    const resolved = kernel.modelRegistry.resolve(kernel.session.activeModelAlias);
    stderr.write(
      `${banner(
        {
          version: KERNEL_VERSION,
          model: kernel.session.activeModelAlias,
          profile: kernel.config.security.permissionProfile ?? 'workspace-dev',
          approvalMode: describeApprovalMode(kernel.session.approvalMode),
          ...(resolved ? { contextWindow: resolved.profile.contextWindow } : {}),
          isolation: `${enforcement.label} — network from Shell is ${networkEnforcementLabel(descriptor)}`,
          caveat: enforcement.caveat,
          workspace: kernel.workspaceRoot,
        },
        palette,
        glyphs,
        columns(),
      )}\n\n`,
    );
  }

  // Attachment notices are chrome: stderr, dim on a terminal, plain in a pipe.
  const note = (text: string): void => {
    stderr.write(`${palette.grey(text)}\n`);
  };

  let exitCode: ExitCode = EXIT.OK;
  try {
    if (args.prompt) {
      const prompt = await withReferences(args.prompt, kernel.workspaceRoot, note);
      exitCode = await runOnce(kernel, prompt, args.json, renderer);
      // `mycoder "do the thing"` from a script is a one-shot: do not then wait on
      // stdin that nobody is going to write to.
      if (!interactive) return exitCode;
    }

    if (!interactive || !rl) {
      // Piped input: each non-empty line is a turn.
      for (const line of (await readAllStdin()).split('\n')) {
        if (line.trim() === '') continue;
        const piped = await withReferences(line, kernel.workspaceRoot, note);
        exitCode = await runOnce(kernel, piped, args.json, renderer);
      }
      return exitCode;
    }

    stderr.write(
      `${palette.grey('Type a task, or /help for control commands. Ctrl-C cancels a turn, Ctrl-D exits.')}\n\n`,
    );

    // The line editor owns the whole input block now, the frame around it included
    // (ADR-0032). `keepFrame` is gone with it: it existed because readline erased
    // everything below its line on every keystroke, and nothing erases the frame here
    // because the thing that draws it is the thing that clears it.
    // `@` candidates for the token being typed. Kept current by `onChange` because
    // the index is asynchronous and Tab is not: a completion that had to await would
    // either block the keystroke or arrive after the next one.
    let pendingPaths: readonly string[] = [];

    // Workspace paths for `@file`, walked lazily on the first Tab.
    const index = new FileIndex({ root: kernel.workspaceRoot });
    files = index;

    // Remapped keys, if the user has any. A bad file warns and is ignored.
    const keys = await loadKeybindings(dirs.config);
    for (const warning of keys.warnings) stderr.write(`warning: ${warning}\n`);

    const editor = new Editor({
      input: stdin,
      write: (text) => stderr.write(text),
      palette,
      glyphs,
      columns,
      rows,
      // Read on every draw, so the Shift-Tab handler below only has to redraw.
      prompt: () => {
        const mode = kernel.session.approvalMode;
        return (
          modeIndicator(mode, describeApprovalMode(mode).label, palette) + `${palette.accent(glyphs.prompt)} `
        );
      },
      continuation: '  ',
      /**
       * Shift-Tab: next mode.
       *
       * Shares `applyApprovalMode` with `/mode`, so the keystroke does everything
       * the command does — including the projection, which is the part that would
       * have been silently dropped. A mode the model is not told about is a model
       * that keeps proposing edits plan mode will deny.
       *
       * Synchronous on purpose. Going through `control.execute` meant awaiting a
       * promise and writing from its `.then()`, which landed after the editor had
       * redrawn and printed the message into the middle of the prompt block.
       */
      onCycleMode: () => {
        const result = applyApprovalMode(kernel.session, 'next');
        if (result.projection) kernel.context.appendControlResult(result.projection);
        return palette.grey(result.message);
      },
      onChange: (text) => {
        const at = text.lastIndexOf('@');
        if (at === -1 || /\s/.test(text.slice(at + 1))) {
          pendingPaths = [];
          return;
        }
        void index.complete(text.slice(at + 1)).then((found) => {
          pendingPaths = found;
        });
      },
      onEnd: (listener) => {
        stdin.once('end', listener);
        return () => void stdin.off('end', listener);
      },
      // The box, and only where it is being drawn live. A pipe and `--no-colour` get
      // no chrome at all rather than a box in ASCII: the frame is decoration around
      // an input nobody is typing into, and drawing it into a log is what the whole
      // "plain when it is not a terminal" rule exists to prevent.
      ...(colour ? { frame: () => inputFrame(palette, glyphs, columns()) } : {}),
      keybindings: keys.overrides,
      // Two completions behind one key. The token under the cursor decides which:
      // a line starting with `/` is a command, an `@` anywhere is a path.
      complete: (text) => {
        if (text.startsWith('/')) {
          return controlCommands.map((name) => `/${name}`).filter((c) => c.startsWith(text));
        }
        const at = text.lastIndexOf('@');
        if (at === -1 || /\s/.test(text.slice(at + 1))) return [];
        return pendingPaths;
      },
    });

    // Ctrl-C during a *turn* cancels it; inside the editor it is the editor's own key
    // and returns null. An interrupted turn still has to close its tool calls and
    // flush its event log, which is why this is not a process-level kill.
    const cancelTurn = () => {
      if (kernel.session.cancel()) stderr.write('\nCancelling…\n');
    };
    process.on('SIGINT', cancelTurn);

    try {
      for (;;) {
        renderer.quiet();
        const outcome = await editor.read();
        // Ctrl-D, or the input stream ending: leave. Ctrl-C abandons the line and
        // stays, which is what the banner promises and what a shell does.
        if (outcome.kind === 'eof') break;
        if (outcome.kind === 'cancel') continue;
        const line = outcome.text;
        if (line.trim() === '') continue;
        if (line.trim() === '/exit' || line.trim() === '/quit') break;
        if (colour) stderr.write(submitted(line.trim(), palette, glyphs));

        const sent = await withReferences(line, kernel.workspaceRoot, note);
        exitCode = await runOnce(kernel, sent, args.json, renderer);
      }
    } finally {
      process.off('SIGINT', cancelTurn);
      editor.teardown();
    }
  } finally {
    renderer.quiet();
    await kernel.shutdown();
    rl?.close();
  }

  return exitCode;
}

/**
 * Turn `@path` into an attachment, and say what happened.
 *
 * Every input path goes through this — the one-shot argument, a piped line, and the
 * interactive prompt — because `@src/app.ts` means the same thing wherever it was
 * typed. It was interactive-only at first, on the argument that a pipe has no user to
 * be helpful to; but `mycoder "explain @src/app.ts"` is a person at a shell, and a
 * feature that works in one of three places is a feature nobody trusts.
 *
 * The rules do not change with the path: only files inside the workspace resolve, and
 * anything else stays literal text and says so on stderr.
 */
async function withReferences(
  line: string,
  workspaceRoot: string,
  note: (text: string) => void,
): Promise<string> {
  const resolved = await resolveReferences(line, workspaceRoot);
  for (const attached of resolved.attached) note(`attached ${attached}`);
  for (const skip of resolved.skipped) note(`${skip.token} left as text — ${skip.reason}`);
  return resolved.text;
}

/** Drain piped stdin in one go. Returns '' for a terminal. */
async function readAllStdin(): Promise<string> {
  if (stdin.isTTY) return '';
  stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data;
}

async function runOnce(
  kernel: Kernel,
  input: string,
  json: boolean,
  renderer?: SessionRenderer,
): Promise<ExitCode> {
  const trimmed = input.trim();

  // Control commands never reach the model.
  if (kernel.control.isCommand(trimmed)) {
    const result = await kernel.control.execute(trimmed);
    if (json) emit({ type: 'control', ...result });
    else stdout.write(`${result.message}\n\n`);

    // Project the state change so the model's next step knows about it.
    if (result.projection) kernel.context.appendControlResult(result.projection);
    return result.ok ? EXIT.OK : EXIT.USAGE;
  }

  // A leading `!` runs a command directly. It is parsed into argv here, so the
  // escalation to a real shell is explicit rather than implied (spec §9.2).
  if (trimmed.startsWith('!')) {
    const plan = parseShellLine(trimmed.slice(1));
    if (plan.kind === 'error') {
      stderr.write(`Could not parse that command: ${plan.message}\n`);
      return EXIT.USAGE;
    }
    stderr.write(
      `Interpreted as: ${describePlan(plan)}\n` +
        'Pass this to the agent as a task if you want it run under policy.\n',
    );
    return EXIT.OK;
  }

  const outcome = await kernel.session.runTurn(trimmed);

  if (json) {
    emit({
      type: 'turn',
      state: outcome.turn.state,
      steps: outcome.steps,
      text: outcome.finalText,
      ...(outcome.error ? { error: outcome.error } : {}),
      exit: exitCodeForTurn(outcome.turn.state, outcome.error?.code),
    });
  } else {
    // When the renderer streamed the answer these are the same bytes, already on
    // screen; printing `finalText` as well would say everything twice.
    if (outcome.finalText && renderer?.streamedAnswer() !== true) {
      stdout.write(`\n${sanitiseModelText(outcome.finalText)}\n\n`);
    } else if (outcome.finalText) {
      stdout.write('\n');
    }
    const footer = renderer?.footer();
    if (footer) stderr.write(`${footer}\n`);
    if (renderer) {
      const usage = kernel.session.usageSnapshot;
      const resolved = kernel.modelRegistry.resolve(kernel.session.activeModelAlias);
      stderr.write(
        `${statusLine(
          {
            model: kernel.session.activeModelAlias,
            ...(resolved ? { contextWindow: resolved.profile.contextWindow } : {}),
            requests: usage.modelRequests,
            tokens: usage.inputTokens + usage.outputTokens,
            costUsd: kernel.session.costBreakdown.totalUsd,
            unpricedRequests: kernel.session.costBreakdown.unpricedRequests,
          },
          renderer.palette,
        )}\n\n`,
      );
    }
    if (outcome.error) {
      stderr.write(`\n${outcome.error.code}: ${outcome.error.message}\n\n`);
    }
    if (outcome.turn.state === 'cancelled') stderr.write('Turn cancelled.\n\n');
  }

  return exitCodeForTurn(outcome.turn.state, outcome.error?.code);
}

/** True when this module is the process entry point, on every platform. */
function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

// Run when invoked directly rather than imported. `pathToFileURL` is required
// rather than string concatenation: on Windows `process.argv[1]` is a
// backslash path, so `file://${argv[1]}` never equals `import.meta.url` and the
// entry point silently does nothing — exit 0, no output, no error.
//
// Since alpha.8 the packaged entry point is `bin/mycoder.mjs`, which calls
// `main` itself after checking the runtime version; this guard keeps
// `node src/cli/main.ts` working in a checkout.
if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = EXIT.INTERNAL;
    });
}
