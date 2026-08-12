/**
 * CLI argument parsing (spec §15.1).
 *
 *   agent [prompt]
 *   agent -c, --continue
 *   agent -r, --resume <session-id>
 *   agent -m, --model <alias>
 *   agent --profile <permission-profile>
 *   agent --cwd <path>
 *   agent --remote <remote-name>
 *   agent --read-only
 *   agent --no-telemetry
 *   agent --json
 *
 * Hand-rolled rather than pulled from a CLI library: the flag set is small and
 * fixed, and these flags sit above project configuration in the priority order
 * (§22), so it is worth being able to read exactly how each one is interpreted.
 */

export interface CliArgs {
  prompt?: string;
  continueSession: boolean;
  resumeSessionId?: string;
  model?: string;
  profile?: string;
  cwd?: string;
  remote?: string;
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

  return args;
}

export const USAGE = `agent — a coding agent kernel

Usage:
  agent [prompt]                  start a session, optionally with a first task
  agent -c, --continue            continue the most recent session
  agent -r, --resume <id>         resume a specific session
  agent -m, --model <alias>       select a model (see /model list)
  agent --profile <name>          permission profile: read-only | workspace-dev | review
  agent --cwd <path>              workspace root (defaults to the current directory)
  agent --remote <name>           run tools on a configured SSH remote
  agent --read-only               force the read-only profile
  agent --no-telemetry            disable telemetry entirely
  agent --json                    emit machine-readable events on stdout
  agent --non-interactive         deny anything that would need approval
  agent --print-config            print the effective configuration and exit
  agent --log-level <level>       silent | error | warn | info | debug | trace
  agent -h, --help                this message
  agent -v, --version             print the version

Inside a session, control commands change kernel state directly:
  /model  /goal  /loop  /permissions  /status  /compact  /remote  /help
`;
