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

export interface CliArgs {
  prompt?: string;
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
  backend?: 'local' | 'container';
  readOnly: boolean;
  noTelemetry: boolean;
  json: boolean;
  /** Print the effective config and exit. */
  printConfig: boolean;
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
        if (v === 'local' || v === 'container') args.backend = v;
        else if (v === 'ssh') {
          args.errors.push('--backend ssh is selected with --remote <name>, which names the host.');
        } else if (v !== undefined) {
          args.errors.push(`--backend must be local or container, not "${v}"`);
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

  if (positional.length > 0) args.prompt = positional.join(' ');

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
  mycoder --backend container       run commands in a container (fails if docker is unusable)
  mycoder --read-only               force the read-only profile
  mycoder --no-telemetry            disable telemetry entirely
  mycoder --json                    emit machine-readable events on stdout
  mycoder --non-interactive         deny anything that would need approval
  mycoder --print-config            print the effective configuration and exit
  mycoder --log-level <level>       silent | error | warn | info | debug | trace
  mycoder -h, --help                this message
  mycoder -v, --version             print the version

Inside a session, control commands change kernel state directly:
  /model  /goal  /loop  /permissions  /status  /compact  /remote  /help
`;
