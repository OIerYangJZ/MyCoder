/**
 * Shell tool (spec §9.2).
 *
 * The protocol is **argv**, never a raw command string. A string protocol makes
 * the shell the parser, which means the kernel's idea of what will run and the
 * shell's idea differ exactly where it matters — quoting, substitution, `;`,
 * backticks. If a UI wants to let a human type a command line, it parses it into
 * argv first (see `src/cli/shell-parse.ts`); the model never gets that
 * affordance.
 *
 * Network is off by default and must be declared. With a policy-enforced backend
 * this is **best-effort**, and both the approval prompt and `/status` say so
 * rather than implying an enforced boundary (spec §12.3, invariant 5).
 *
 * Path-like argv tokens are canonicalised and declared as `file.read` accesses.
 * That is what turns `cat .env` and `python -c 'open(".env").read()'` into a
 * hard deny at the policy layer instead of relying on output redaction alone.
 */

import * as path from 'node:path';

import type { JsonSchema } from '../../util/jsonschema.ts';
import { truncateForModel } from '../../util/text.ts';
import { sha256Hex } from '../../util/ids.ts';
import { isWithin, type CanonicalPath } from '../../util/paths.ts';
import type { AccessRequest } from '../../policy/access.ts';
import type { SecretLease } from '../../security/secret-broker.ts';
import { MutationDetector, type WorkspaceChange } from '../../execution/mutation-detector.ts';
import {
  errorResult,
  okResult,
  refusedExecution,
  type ToolDefinition,
  type ToolExecution,
  type ToolResolveContext,
} from '../contract.ts';

export interface ShellArgs {
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
  network?: false | { hosts?: string[] };
  secrets?: Array<{ ref: string; env: string }>;
  stdin?: string;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    argv: {
      type: 'array',
      description:
        'Command and arguments as separate array elements, e.g. ["npm","test"]. ' +
        'This is not a shell line: no quoting, globbing, pipes or redirection are interpreted. ' +
        'To use shell features explicitly, run ["bash","-lc","..."].',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 256,
    },
    cwd: { type: 'string', description: 'Working directory. Defaults to the workspace root.' },
    timeoutMs: {
      type: 'integer',
      description: 'Timeout in milliseconds. Defaults to 120000.',
      minimum: 100,
      maximum: 900_000,
    },
    network: {
      anyOf: [
        { const: false },
        {
          type: 'object',
          properties: { hosts: { type: 'array', items: { type: 'string' } } },
          additionalProperties: false,
        },
      ],
      description:
        'Network access. Omit or pass false for no network (the default). To reach the network, ' +
        'pass {"hosts":["registry.npmjs.org"]} — this requires approval.',
    },
    secrets: {
      type: 'array',
      description:
        'Credentials to inject as environment variables, by reference. ' +
        'Example: [{"ref":"provider/github","env":"GITHUB_TOKEN"}]. The value is never shown to you.',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          env: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
        },
        required: ['ref', 'env'],
        additionalProperties: false,
      },
      maxItems: 8,
    },
    stdin: { type: 'string', description: 'Text to write to the process stdin.' },
  },
  required: ['argv'],
  additionalProperties: false,
};

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ShellToolOptions {
  detector: MutationDetector;
  defaultTimeoutMs?: number;
  /** Called when a shell command changed source/test/config files. */
  onUndeclaredMutation?: (changes: WorkspaceChange[], toolCallId: string) => void;
  /** Called for every execution, for the audit event. */
  onExecuted?: (record: {
    toolCallId: string;
    executable: string;
    argvSummary: string;
    argvHash: string;
    cwd: string;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    timedOut: boolean;
    networkRequested: boolean;
    stdoutBytes: number;
    stderrBytes: number;
  }) => void;
}

export function createShellTool(opts: ShellToolOptions): ToolDefinition<ShellArgs> {
  return {
    name: 'Shell',
    description:
      'Run a command as an argv array. There is no shell interpretation: use ["bash","-lc","..."] ' +
      'if you need pipes or globbing. The environment is scrubbed of credentials, network is off ' +
      'unless declared, and output is truncated and redacted. Changes this command makes to source ' +
      'files are detected and reported.',
    inputSchema: SCHEMA,
    disclosure: 'eager',
    readOnly: false,

    async resolve(args: ShellArgs, ctx: ToolResolveContext): Promise<ToolExecution> {
      const argv = args.argv.filter((a) => typeof a === 'string');
      const executable = argv[0] ?? '';
      const argvSummary = summarizeArgv(argv);

      const cwdResolved = args.cwd
        ? await ctx.canonicalize(args.cwd)
        : { path: ctx.workspaceRoot, existed: true };
      const cwd = cwdResolved.path;
      const cwdDisplay = ctx.display(cwd);

      // `network` is `false | { hosts?: string[] }`, so truthiness already
      // excludes the "no network" case.
      const networkHosts = args.network ? (args.network.hosts ?? []) : [];
      const wantsNetwork = Boolean(args.network);

      const subject = {
        key: `Shell:${path.basename(executable)}:${argv.slice(1, 2).join(' ')}`,
        title: `Run ${argvSummary}`,
        details: [
          `command: ${argvSummary}`,
          `directory: ${cwdDisplay}`,
          wantsNetwork
            ? `network: ${networkHosts.length > 0 ? networkHosts.join(', ') : 'any host'} ` +
              `(${ctx.environment.sandboxStrength === 'os-isolated' ? 'enforced' : 'best-effort — this backend cannot truly block sockets'})`
            : 'network: none requested',
          ...(args.secrets?.length
            ? [`credentials: ${args.secrets.map((s) => `secret_ref://${s.ref} → $${s.env}`).join(', ')}`]
            : []),
        ],
        risk: wantsNetwork || (args.secrets?.length ?? 0) > 0 ? ('high' as const) : ('medium' as const),
      };
      const display = { title: 'Run command', summary: `${argvSummary} in ${cwdDisplay}` };

      if (argv.length === 0 || executable === '') {
        return refusedExecution(
          subject,
          display,
          errorResult('TOOL_INVALID_ARGS', 'argv must contain at least the executable.'),
        );
      }
      if (!cwdResolved.existed) {
        return refusedExecution(
          subject,
          display,
          errorResult('TOOL_INVALID_ARGS', `Working directory does not exist: ${cwdDisplay}`),
        );
      }

      // Declare every path-like token so the policy engine can hard-deny a
      // command that names a protected file. Best-effort by nature — a command
      // can always construct a path at runtime — and documented as such.
      const referencedPaths = await resolveReferencedPaths(argv.slice(1), ctx);

      const accesses: AccessRequest[] = [
        {
          kind: 'process.exec',
          executable,
          argv,
          cwd,
          display: argvSummary,
          ...(isUntrustedExecutable(executable, ctx.workspaceRoot) ? { untrustedExecutable: true } : {}),
        },
        ...referencedPaths.map((p): AccessRequest => ({
          kind: 'file.read',
          path: p.path,
          // The command's output goes to the model, so anything it reads is
          // effectively a read into the model's context.
          toModel: true,
          display: p.display,
        })),
        ...(wantsNetwork
          ? networkHosts.length > 0
            ? networkHosts.map((host): AccessRequest => ({
                kind: 'network.connect',
                host,
                port: 443,
                via: 'shell',
                display: `${host}:443`,
              }))
            : [
                {
                  kind: 'network.connect' as const,
                  host: '*',
                  port: 0,
                  via: 'shell' as const,
                  display: 'any host',
                },
              ]
          : []),
        ...(args.secrets ?? []).map((s): AccessRequest => ({
          kind: 'secret.use',
          secretRef: s.ref,
          display: `secret_ref://${s.ref} → $${s.env}`,
        })),
      ];

      const timeoutMs = args.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

      return {
        accesses,
        approvalSubject: subject,
        display,

        async execute(executor, signal) {
          if (signal.aborted) return errorResult('CANCELLED', 'Command was cancelled before it started.');

          // Snapshot before, so any workspace change is attributable.
          const before = await opts.detector.snapshot(executor, signal, ctx.now());

          const leases: SecretLease[] = [];
          try {
            // Secret injection happens through the executor's capability
            // profile, which the sandbox planner populated from the approved
            // `secret.use` accesses. Nothing here reads a raw value.
            for (const requested of args.secrets ?? []) {
              const alreadyGranted = executor.profile.secretInjections.some(
                (inj) => inj.envName === requested.env,
              );
              if (!alreadyGranted) {
                return errorResult(
                  'SECRET_ACCESS_DENIED',
                  `The credential secret_ref://${requested.ref} was not granted for this command.`,
                );
              }
            }

            const result = await executor.exec(
              {
                argv,
                cwd,
                timeoutMs,
                ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
              },
              signal,
            );

            const after = await opts.detector.snapshot(executor, signal, ctx.now());
            const changes = opts.detector.diff(before, after);
            const undeclared = MutationDetector.undeclared(changes);

            if (undeclared.length > 0) {
              opts.onUndeclaredMutation?.(undeclared, ctx.toolCallId);
            }
            // Receipts are deliberately *not* invalidated here. The freshness
            // ledger compares content hashes, so a changed file already fails
            // with STALE_FILE — which tells the model what actually happened.
            // Deleting the receipt instead would degrade that into "no such
            // receipt", losing the reason at exactly the moment it matters.

            opts.onExecuted?.({
              toolCallId: ctx.toolCallId,
              executable,
              argvSummary,
              argvHash: sha256Hex(argv.join(' ')).slice(0, 16),
              cwd: cwdDisplay,
              exitCode: result.exitCode,
              signal: result.signal,
              durationMs: result.durationMs,
              timedOut: result.timedOut,
              networkRequested: wantsNetwork,
              stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
              stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
            });

            if (result.timedOut) {
              return {
                content:
                  `error: TOOL_TIMEOUT\nThe command did not finish within ${timeoutMs} ms and was terminated.\n\n` +
                  renderStreams(result.stdout, result.stderr),
                isError: true,
                errorCode: 'TOOL_TIMEOUT',
                metadata: { timedOut: true, durationMs: result.durationMs },
              };
            }

            const body = renderStreams(result.stdout, result.stderr);
            const budgeted = truncateForModel(body, { maxBytes: 48 * 1024, maxLines: 1000 });

            const mutationNote = changes.length > 0 ? `\n\n${MutationDetector.describe(changes)}` : '';
            const undeclaredNote =
              undeclared.length > 0
                ? `\nWarning: ${undeclared.length} source/test/config file(s) were changed by this command ` +
                  'rather than by an Edit. Review them before continuing.'
                : '';

            const header =
              result.exitCode === 0
                ? `exit 0 (${result.durationMs} ms)`
                : `exit ${result.exitCode ?? 'null'}${result.signal ? ` (signal ${result.signal})` : ''} ` +
                  `(${result.durationMs} ms)`;

            return {
              content: `${header}\n\n${budgeted.text}${mutationNote}${undeclaredNote}`,
              // A non-zero exit is information the model must act on, so it is
              // reported as an error result rather than a successful one.
              isError: result.exitCode !== 0,
              ...(result.exitCode !== 0 ? { errorCode: 'TOOL_FAILED' as const } : {}),
              structured: {
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                changedFiles: changes.map((c) => ({ path: c.path, kind: c.kind })),
                truncated: budgeted.truncated,
              },
              metadata: {
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                changed: changes.length,
                undeclared: undeclared.length,
                snapshotStrategy: before.strategy,
              },
              ...(budgeted.truncated ? { fullOutput: body } : {}),
            };
          } finally {
            for (const lease of leases) lease.release();
          }
        },
      };
    },
  };
}

function renderStreams(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim() !== '') parts.push(stdout.trimEnd());
  if (stderr.trim() !== '') parts.push(`--- stderr ---\n${stderr.trimEnd()}`);
  return parts.length === 0 ? '(no output)' : parts.join('\n\n');
}

function summarizeArgv(argv: readonly string[]): string {
  const rendered = argv.map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a)).join(' ');
  return rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered;
}

/**
 * Pull plausible filesystem paths out of an argv.
 *
 * Covers the direct case (`cat .env`), the flag case (`--env-file=.env`) and the
 * embedded case (`python -c 'open(".env")'`). It cannot cover a path the program
 * computes at runtime — that is what output redaction is for — but it does turn
 * the three attacks in spec §26.1 that are expressible in argv into policy
 * denials rather than redactions after the fact.
 */
async function resolveReferencedPaths(
  tokens: readonly string[],
  ctx: ToolResolveContext,
): Promise<Array<{ path: CanonicalPath; display: string }>> {
  const candidates = new Set<string>();

  for (const token of tokens) {
    if (token.length > 4096) continue;

    // `--flag=value` and `-fvalue`
    const eq = token.indexOf('=');
    const bare = token.startsWith('-') && eq > 0 ? token.slice(eq + 1) : token;
    if (!bare.startsWith('-')) addCandidate(candidates, bare);

    // Quoted strings inside a `-c` program or a shell line.
    for (const m of token.matchAll(/["']([^"'\n]{1,512})["']/g)) {
      addCandidate(candidates, m[1]!);
    }

    // A `-c` script is a whole command line inside one argv element. Looking
    // only at the element as a unit misses every path in it: `sh -c 'tar cf -
    // .env | base64'` names `.env` but contains no quotes and no separator, so
    // neither branch above sees it. That gap was a live exfiltration route —
    // the tar was base64'd, and redaction cannot recognise a secret re-encoded
    // at an arbitrary byte offset. Split embedded command lines apart.
    if (/[\s;|&><`()]/.test(token)) {
      for (const piece of token.split(/[\s;|&><`()[\]{}]+/)) {
        addCandidate(candidates, piece.replace(/^["']|["']$/g, ''));
      }
    }
  }

  const out: Array<{ path: CanonicalPath; display: string }> = [];
  for (const candidate of candidates) {
    try {
      const resolved = await ctx.canonicalize(candidate);
      if (!resolved.existed) continue;
      out.push({ path: resolved.path, display: ctx.display(resolved.path) });
    } catch {
      // Not a usable path; nothing to declare.
    }
    if (out.length >= 32) break;
  }
  return out;
}

function addCandidate(into: Set<string>, raw: string): void {
  const value = raw.trim();
  if (value === '' || value.length > 4096) return;
  // Only things that plausibly name a file: contains a separator, starts with a
  // dot, or has a file extension.
  if (!/[/\\]/.test(value) && !value.startsWith('.') && !/\.[A-Za-z0-9]{1,8}$/.test(value)) return;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return; // a URL, not a path
  into.add(value);
}

function isUntrustedExecutable(executable: string, workspaceRoot: CanonicalPath): boolean {
  // A bare name resolves through PATH and is treated as trusted tooling; an
  // explicit path into the workspace is a script the model may have just
  // written, which is a different risk.
  if (!executable.includes('/') && !executable.includes('\\')) return false;
  return isWithin(workspaceRoot, path.resolve(executable) as CanonicalPath);
}
