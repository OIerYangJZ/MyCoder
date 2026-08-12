#!/usr/bin/env node
/**
 * CLI entry point (spec §15).
 *
 * Deliberately thin: parse flags, build the kernel, then loop over input,
 * dispatching each line either to the control plane (if it starts with `/`) or
 * to the agent loop. Everything interesting happens behind `createKernel`.
 *
 * A raw shell line typed by the user is parsed into argv before it can reach the
 * Shell tool (§9.2), which is why `parseShellLine` is imported here and not
 * inside the tool.
 */

import * as readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';

import { createKernel, KERNEL_VERSION, type Kernel } from '../kernel.ts';
import { describeConfig } from '../config/config.ts';
import { findMostRecentSession, describeResume, replaySession } from '../session/resume.ts';
import { FileSessionStore } from '../session/store.ts';
import { Redactor } from '../security/redactor.ts';
import { resolveKernelDirs, sessionsDir } from '../util/platform.ts';
import type { LogLevel } from '../util/logger.ts';
import { parseArgs, USAGE } from './args.ts';
import { TerminalApprovalPrompter } from './prompter.ts';
import { parseShellLine, describePlan } from './shell-parse.ts';

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (args.version) {
    stdout.write(`${KERNEL_VERSION}\n`);
    return 0;
  }
  if (args.errors.length > 0) {
    for (const error of args.errors) stderr.write(`error: ${error}\n`);
    stderr.write('\nRun `agent --help` for usage.\n');
    return 2;
  }

  // Resolve which session to use before building the kernel, so `-c` and `-r`
  // can be reported clearly rather than failing deep inside bootstrap.
  let resumeSessionId = args.resumeSessionId;
  if (args.continueSession && !resumeSessionId) {
    const dirs = resolveKernelDirs();
    const probeStore = new FileSessionStore({ rootDir: sessionsDir(dirs), redactor: new Redactor() });
    const recent = await findMostRecentSession(probeStore);
    if (!recent) {
      stderr.write('No previous session was found to continue.\n');
      return 1;
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

  let kernel: Kernel;
  try {
    kernel = await createKernel({
      workspaceDir: args.cwd ?? process.cwd(),
      ...(args.profile ? { profileOverride: args.profile } : {}),
      ...(args.model ? { modelOverride: args.model } : {}),
      ...(args.remote ? { remoteName: args.remote } : {}),
      ...(args.noTelemetry ? { telemetryDisabled: true } : {}),
      ...(args.logLevel ? { logLevel: args.logLevel as LogLevel } : {}),
      json: args.json,
      nonInteractive: args.nonInteractive || !interactive,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(rl && !args.nonInteractive
        ? { prompter: new TerminalApprovalPrompter({ rl, write: (t) => stderr.write(t) }) }
        : {}),
    });
  } catch (e) {
    rl?.close();
    stderr.write(`Failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  if (args.printConfig) {
    stdout.write(`${describeConfig(kernel.config, kernel.configSources)}\n`);
    await kernel.shutdown();
    rl?.close();
    return 0;
  }

  for (const warning of kernel.config.warnings) {
    stderr.write(`warning: ${warning}\n`);
  }

  if (resumeSessionId) {
    const replayed = await replaySession(kernel.store, kernel.sessionId);
    if (replayed) stderr.write(`${describeResume(replayed)}\n`);
  }

  const status = await kernel.control.execute('/status');
  stderr.write(`${status.message}\n\n`);

  let exitCode = 0;
  try {
    if (args.prompt) {
      exitCode = await runOnce(kernel, args.prompt, args.json);
      // `agent "do the thing"` from a script is a one-shot: do not then wait on
      // stdin that nobody is going to write to.
      if (!interactive) return exitCode;
    }

    if (!interactive || !rl) {
      // Piped input: each non-empty line is a turn.
      for (const line of (await readAllStdin()).split('\n')) {
        if (line.trim() === '') continue;
        exitCode = await runOnce(kernel, line, args.json);
      }
      return exitCode;
    }

    stderr.write('Type a task, or /help for control commands. Ctrl-C to cancel a turn, Ctrl-D to exit.\n\n');

    // Ctrl-C cancels the turn rather than killing the process — an interrupted
    // turn still has to close its tool calls and flush its event log.
    rl.on('SIGINT', () => {
      if (kernel.session.cancel()) stderr.write('\nCancelling…\n');
      else stderr.write('\n(nothing to cancel; Ctrl-D to exit)\n');
    });

    for (;;) {
      let line: string;
      try {
        line = await rl.question('> ');
      } catch {
        break; // Ctrl-D
      }
      if (line.trim() === '') continue;
      if (line.trim() === '/exit' || line.trim() === '/quit') break;
      exitCode = await runOnce(kernel, line, args.json);
    }
  } finally {
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

async function runOnce(kernel: Kernel, input: string, json: boolean): Promise<number> {
  const trimmed = input.trim();

  // Control commands never reach the model.
  if (kernel.control.isCommand(trimmed)) {
    const result = await kernel.control.execute(trimmed);
    if (json) stdout.write(`${JSON.stringify({ type: 'control', ...result })}\n`);
    else stdout.write(`${result.message}\n\n`);

    // Project the state change so the model's next step knows about it.
    if (result.projection) kernel.context.appendControlResult(result.projection);
    return result.ok ? 0 : 1;
  }

  // A leading `!` runs a command directly. It is parsed into argv here, so the
  // escalation to a real shell is explicit rather than implied (spec §9.2).
  if (trimmed.startsWith('!')) {
    const plan = parseShellLine(trimmed.slice(1));
    if (plan.kind === 'error') {
      stderr.write(`Could not parse that command: ${plan.message}\n`);
      return 1;
    }
    stderr.write(
      `Interpreted as: ${describePlan(plan)}\n` +
        'Pass this to the agent as a task if you want it run under policy.\n',
    );
    return 0;
  }

  const outcome = await kernel.session.runTurn(trimmed);

  if (json) {
    stdout.write(
      `${JSON.stringify({
        type: 'turn',
        state: outcome.turn.state,
        steps: outcome.steps,
        text: outcome.finalText,
        ...(outcome.error ? { error: outcome.error } : {}),
      })}\n`,
    );
  } else {
    if (outcome.finalText) stdout.write(`\n${outcome.finalText}\n\n`);
    if (outcome.error) {
      stderr.write(`\n${outcome.error.code}: ${outcome.error.message}\n\n`);
    }
    if (outcome.turn.state === 'cancelled') stderr.write('Turn cancelled.\n\n');
  }

  return outcome.turn.state === 'completed' ? 0 : 1;
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
if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
