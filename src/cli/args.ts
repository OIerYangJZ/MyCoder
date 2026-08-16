/**
 * CLI argument parsing (spec §15.1).
 *
 *   mycoder [prompt]
 *   mycoder -c, --continue
 *   mycoder -r, --resume <session-id>
 *   mycoder -m, --model <alias>
 *   mycoder --profile <permission-profile>
 *   mycoder --cwd <path>
 *   mycoder --remote <remote-name>
 *   mycoder --read-only
 *   mycoder --no-telemetry
 *   mycoder --json
 *
 * Hand-rolled rather than pulled from a CLI library: the flag set is small and
 * fixed, and these flags sit above project configuration in the priority order
 * (§22), so it is worth being able to read exactly how each one is interpreted.
 */

import { APP_DISPLAY_NAME } from '../app.ts';

/**
 * Subcommands (alpha.8).
 *
 * A small closed set rather than a general dispatcher: each of these is a thing
 * you do to an *installation* rather than to a session, and each is answered
 * without building a kernel — which is the point, since you reach for them when
 * the kernel will not start.
 */
export type Subcommand = 'doctor' | 'build-sandbox' | 'setup-credential';

export const SUBCOMMANDS: readonly Subcommand[] = ['doctor', 'build-sandbox', 'setup-credential'];

export interface CliArgs {
  prompt?: string;
  /** A subcommand, when argv[0] named one. */
  command?: Subcommand;
  /** The subcommand's single positional argument. */
  commandArg?: string;
  continueSession: boolean;
  resumeSessionId?: string;
  model?: string;
  profile?: string;
  cwd?: string;
  remote?: string;
  /**
   * Execution backend (alpha.5 §40).
   *
   * `--backend container` is a *requirement*, not a preference: if the runtime is
   * unusable the session fails to start. There is deliberately no
   * `--backend auto`, because "try the container and fall back" is the silent
   * degradation of a security decision.
   */
  backend?: 'local' | 'container' | 'linux-native';
  readOnly: boolean;
  noTelemetry: boolean;
  json: boolean;
  /** Print the effective config and exit. */
  printConfig: boolean;
  /** Report whether the native launcher matches this kernel (ADR-0020 §4). */
  sandboxStatus: boolean;
  /** Replace an existing credential file rather than refusing. */
  force: boolean;
  help: boolean;
  version: boolean;
  logLevel?: string;
  /** Non-interactive: every approval request is denied instead of prompting. */
  nonInteractive: boolean;
  errors: string[];
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    continueSession: false,
    readOnly: false,
    noTelemetry: false,
    json: false,
    printConfig: false,
    sandboxStatus: false,
    force: false,
    help: false,
    version: false,
    nonInteractive: false,
    errors: [],
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    const takeValue = (flag: string): string | undefined => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        args.errors.push(`${flag} requires a value`);
        return undefined;
      }
      i += 1;
      return next;
    };

    switch (arg) {
      case '-c':
      case '--continue':
        args.continueSession = true;
        break;

      case '-r':
      case '--resume': {
        const v = takeValue(arg);
        if (v) args.resumeSessionId = v;
        break;
      }

      case '-m':
      case '--model': {
        const v = takeValue(arg);
        if (v) args.model = v;
        break;
      }

      case '--profile': {
        const v = takeValue(arg);
        if (v) args.profile = v;
        break;
      }

      case '--cwd': {
        const v = takeValue(arg);
        if (v) args.cwd = v;
        break;
      }

      case '--remote': {
        const v = takeValue(arg);
        if (v) args.remote = v;
        break;
      }

      case '--backend': {
        const v = takeValue(arg);
        if (v === 'local' || v === 'container' || v === 'linux-native') args.backend = v;
        else if (v === 'ssh') {
          args.errors.push('--backend ssh is selected with --remote <name>, which names the host.');
        } else if (v !== undefined) {
          args.errors.push(`--backend must be local, container or linux-native, not "${v}"`);
        }
        break;
      }

      case '--log-level': {
        const v = takeValue(arg);
        if (v) args.logLevel = v;
        break;
      }

      case '--read-only':
        args.readOnly = true;
        break;

      case '--no-telemetry':
        args.noTelemetry = true;
        break;

      case '--json':
        args.json = true;
        break;

      case '--non-interactive':
        args.nonInteractive = true;
        break;

      case '--print-config':
        args.printConfig = true;
        break;

      case '--sandbox-status':
        args.sandboxStatus = true;
        break;

      case '--force':
        args.force = true;
        break;

      case '-h':
      case '--help':
        args.help = true;
        break;

      case '-v':
      case '--version':
        args.version = true;
        break;

      case '--':
        positional.push(...argv.slice(i + 1));
        i = argv.length;
        break;

      default:
        if (arg.startsWith('-') && arg.length > 1) args.errors.push(`Unknown flag "${arg}"`);
        else positional.push(arg);
    }
  }

  // A subcommand only counts in first position. `mycoder "run doctor on this"`
  // is a task, not an invocation of `doctor`, and a bare word later in the line
  // is part of the prompt — anything else would make some prompts unspeakable.
  const first = positional[0];
  if (first !== undefined && (SUBCOMMANDS as readonly string[]).includes(first)) {
    args.command = first as Subcommand;
    if (positional.length > 1) args.commandArg = positional.slice(1).join(' ');
  } else if (positional.length > 0) {
    args.prompt = positional.join(' ');
  }

  // `--read-only` is a hard narrowing, so it wins over an explicit --profile
  // rather than being silently overridden by it.
  if (args.readOnly && args.profile && args.profile !== 'read-only') {
    args.errors.push(
      `--read-only conflicts with --profile ${args.profile}. --read-only was applied; drop one of them.`,
    );
    args.profile = 'read-only';
  }
  if (args.readOnly) args.profile = 'read-only';

  // Two backends cannot both be the backend. Reported rather than resolved by a
  // precedence rule, because either guess would silently run the session
  // somewhere the user did not ask for.
  if (args.backend === 'container' && args.remote) {
    args.errors.push(
      '--backend container and --remote name two different execution backends. ' +
        'Running a container on a remote host is not implemented in v0.1; pick one.',
    );
  }

  return args;
}

export const USAGE = `${APP_DISPLAY_NAME} — a coding agent kernel

Usage:
  mycoder [prompt]                  start a session, optionally with a first task
  mycoder -c, --continue            continue the most recent session
  mycoder -r, --resume <id>         resume a specific session
  mycoder -m, --model <alias>       select a model (see /model list)
  mycoder --profile <name>          permission profile: read-only | workspace-dev | review
  mycoder --cwd <path>              workspace root (defaults to the current directory)
  mycoder --remote <name>           run tools on a configured SSH remote
  mycoder --backend <kind>          local | container (container fails if docker is unusable)
  mycoder --read-only               force the read-only profile
  mycoder --no-telemetry            disable telemetry entirely
  mycoder --json                    emit machine-readable events on stdout
  mycoder --non-interactive         deny anything that would need approval
  mycoder --print-config            print the effective configuration and exit
  mycoder --log-level <level>       silent | error | warn | info | debug | trace
  mycoder -h, --help                this message
  mycoder -v, --version             print the version

Setup and diagnosis — none of these start a session:
  mycoder doctor                    is this installation ready? names every remedy
  mycoder setup-credential <path>   write an API key the kernel will accept, from stdin
  mycoder build-sandbox             build the native Linux launcher (needs a C compiler)

Experimental — may change or disappear in any release (ADR-0021):
  mycoder --backend linux-native    Landlock/seccomp sandbox; refuses, never degrades
  mycoder --sandbox-status          does the built launcher match this kernel?

Exit codes (ADR-0021):
  0 ok   1 incomplete   2 usage   3 config   4 denied   5 unavailable   6 internal

Inside a session, control commands change kernel state directly:
  /model  /goal  /loop  /permissions  /status  /compact  /remote  /help
`;

/**
 * The stability of each flag (ADR-0021 §1).
 *
 * A table rather than a comment, because `--help` prints from it and
 * `tests/integration/cli-contract.test.ts` asserts against it: a flag that
 * exists in neither list is a flag nobody decided the stability of, which is the
 * state every flag here was in before alpha.8.
 */
export const CONTRACT_FLAGS: readonly string[] = [
  '-c',
  '--continue',
  '-r',
  '--resume',
  '-m',
  '--model',
  '--profile',
  '--cwd',
  '--remote',
  '--read-only',
  '--no-telemetry',
  '--json',
  '--non-interactive',
  '--print-config',
  '--log-level',
  // The *flag* is contract; one of its values is not. See CONTRACT_BACKENDS.
  '--backend',
  '-h',
  '--help',
  '-v',
  '--version',
  '--',
];

export const EXPERIMENTAL_FLAGS: readonly string[] = ['--sandbox-status', '--force'];

/**
 * `--backend` is split: the flag is contract, one of its values is not.
 *
 * `linux-native`'s *refusal* behaviour is contract and is the security property.
 * What is experimental is the enforcement-descriptor vocabulary ADR-0018
 * introduced, which has had exactly one consumer — freezing a vocabulary with
 * one user is how you get a vocabulary you cannot fix.
 */
export const CONTRACT_BACKENDS: readonly string[] = ['local', 'container'];
export const EXPERIMENTAL_BACKENDS: readonly string[] = ['linux-native'];
