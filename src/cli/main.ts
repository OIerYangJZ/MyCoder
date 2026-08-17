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
import { findMostRecentSession, describeResume, replaySession } from '../session/resume.ts';
import { FileSessionStore } from '../session/store.ts';
import { Redactor } from '../security/redactor.ts';
import { resolveKernelDirs, sessionsDir } from '../util/platform.ts';
import { toKernelError, type ErrorCode } from '../util/errors.ts';
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
  colourEnabled,
  discardInput,
  glyphs as glyphSet,
  openInput,
  palette as makePalette,
  redrawBottomRule,
  SessionRenderer,
  statusLine,
  submitted,
} from './render.ts';
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
    const { text, exit } = await printConfig({ workspaceDir: cwd });
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

  // Resolve which session to use before building the kernel, so `-c` and `-r`
  // can be reported clearly rather than failing deep inside bootstrap.
  let resumeSessionId = args.resumeSessionId;
  if (args.continueSession && !resumeSessionId) {
    const probeStore = new FileSessionStore({ rootDir: sessionsDir(dirs), redactor: new Redactor() });
    const recent = await findMostRecentSession(probeStore);
    if (!recent) {
      stderr.write('No previous session was found to continue.\n');
      return EXIT.INCOMPLETE;
    }
    resumeSessionId = recent.sessionId;
  }

  // Only create a readline interface for a real terminal. Attaching one to a
  // pipe consumes the buffered lines before the async iterator is attached, and
  // they are then lost — so piped input is read directly instead.
  const interactive = stdin.isTTY === true;
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

  // How this session will look. `live` is false for `--json` and for anything that
  // is not a terminal: stdout is a contract and a log file should not receive
  // spinner frames.
  // The terminal's width, re-read each time: a window can be resized mid-session.
  const columns = (): number => {
    // A pty with no window size reports 0, and `Math.max(8, 0 - 2)` produced an
    // eight-dash rule that looked like a bug in the frame rather than in the size.
    const reported = stderr.isTTY === true ? stderr.columns : undefined;
    return typeof reported === 'number' && reported > 20 ? reported : 80;
  };

  // lint-allow no-host-env-read: NO_COLOR / TERM / FORCE_COLOR decide styling only.
  // Nothing read here reaches a child process, the model or a log, and no credential
  // can be spelled `NO_COLOR` — the three names are read and nothing else is.
  const colour = colourEnabled(process.env, stderr.isTTY === true) && !args.json;
  const glyphs = glyphSet(colour);
  const palette = makePalette(colour);
  const renderer = new SessionRenderer({
    write: (t) => stderr.write(t),
    palette,
    glyphs,
    live: !args.json && stderr.isTTY === true,
  });

  let kernel: Kernel;
  try {
    kernel = await createKernel({
      onEvent: (type, payload) => renderer.on(type, payload),
      workspaceDir: cwd,
      ...(args.profile ? { profileOverride: args.profile } : {}),
      ...(args.model ? { modelOverride: args.model } : {}),
      ...(args.remote ? { remoteName: args.remote } : {}),
      ...(args.backend ? { backend: args.backend } : {}),
      ...(args.noTelemetry ? { telemetryDisabled: true } : {}),
      ...(args.logLevel ? { logLevel: args.logLevel as LogLevel } : {}),
      json: args.json,
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

  for (const warning of kernel.config.warnings) {
    stderr.write(`warning: ${warning}\n`);
  }

  if (resumeSessionId) {
    const replayed = await replaySession(kernel.store, kernel.sessionId);
    if (replayed) stderr.write(`${describeResume(replayed)}\n`);
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

  let exitCode: ExitCode = EXIT.OK;
  try {
    if (args.prompt) {
      exitCode = await runOnce(kernel, args.prompt, args.json, renderer);
      // `mycoder "do the thing"` from a script is a one-shot: do not then wait on
      // stdin that nobody is going to write to.
      if (!interactive) return exitCode;
    }

    if (!interactive || !rl) {
      // Piped input: each non-empty line is a turn.
      for (const line of (await readAllStdin()).split('\n')) {
        if (line.trim() === '') continue;
        exitCode = await runOnce(kernel, line, args.json, renderer);
      }
      return exitCode;
    }

    stderr.write(
      `${palette.dim('Type a task, or /help for control commands. Ctrl-C cancels a turn, Ctrl-D exits.')}\n\n`,
    );

    // readline's own refresh erases everything below its line, bottom rule included,
    // so it is written again after each keystroke. One line, three escape sequences.
    const keepFrame = (): void => {
      stderr.write(redrawBottomRule(palette, glyphs, columns()));
    };

    // Ctrl-C cancels the turn rather than killing the process — an interrupted
    // turn still has to close its tool calls and flush its event log.
    rl.on('SIGINT', () => {
      if (kernel.session.cancel()) stderr.write('\nCancelling…\n');
      else stderr.write('\n(nothing to cancel; Ctrl-D to exit)\n');
    });

    for (;;) {
      let line: string;
      try {
        renderer.quiet();
        // Both rules first, then the cursor comes back up between them, so the frame
        // is closed while you type. readline erases the bottom rule on every
        // keystroke, so `keepFrame` puts it back.
        if (colour) {
          stderr.write(openInput(palette, glyphs, columns()));
          stdin.on('keypress', keepFrame);
        }
        // `question` writes the prompt synchronously, and readline's own refresh
        // erases everything below that line — including the bottom rule that was
        // just drawn. So it is put back immediately, before the first keystroke,
        // and again from `keepFrame` after every one. Without this the frame looked
        // open until you typed a character, which is how "there is no bottom line"
        // was still true after the first fix.
        const answer = rl.question(`${palette.boldBlue(glyphs.prompt)} `);
        if (colour) stderr.write(redrawBottomRule(palette, glyphs, columns()));
        line = await answer;
        if (colour) {
          stdin.off('keypress', keepFrame);
          // An empty Enter throws the frame away rather than leaving a ladder of
          // empty boxes behind it.
          stderr.write(
            line.trim() === '' ? discardInput() : submitted(line.trim(), palette, glyphs, columns()),
          );
        }
      } catch {
        if (colour) stdin.off('keypress', keepFrame);
        break; // Ctrl-D
      }
      if (line.trim() === '') continue;
      if (line.trim() === '/exit' || line.trim() === '/quit') break;
      exitCode = await runOnce(kernel, line, args.json, renderer);
    }
  } finally {
    renderer.quiet();
    await kernel.shutdown();
    rl?.close();
  }

  return exitCode;
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
    if (outcome.finalText) stdout.write(`\n${outcome.finalText}\n\n`);
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
