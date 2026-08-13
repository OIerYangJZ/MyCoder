/**
 * Hooks (spec §18).
 *
 * Project hooks are ordinary project code that happens to run at a lifecycle
 * point. They go through the executor, get a scrubbed environment, declare their
 * own `AccessRequest`s, sit under the session ceiling, have their stdout
 * redacted, and reach the network only through the egress policy (§18.3).
 *
 * The distinction the spec draws in §14.5 is enforced structurally: the four
 * trusted kernel hooks — `PreModelRequest`, `PreNetworkEgress`,
 * `PreTelemetryExport`, `PreSecretInjection` — are not part of this registry at
 * all. They live in the kernel's own code paths, so there is no configuration
 * key that could point them at a project script.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { projectDirCandidates } from '../app.ts';
import { globMatch } from '../util/glob.ts';
import { parseToml, TomlParseError, type TomlTable, type TomlValue } from '../util/toml.ts';
import { truncateForModel } from '../util/text.ts';
import type { CanonicalPath } from '../util/paths.ts';
import type { Logger } from '../util/logger.ts';
import type { AccessRequest } from '../policy/access.ts';
import { PolicyEngine, decisionToError } from '../policy/policy-engine.ts';
import type { ExecutionBackend } from '../execution/backend.ts';
import { SandboxPlanner } from '../execution/sandbox.ts';

/** Lifecycle points a project may hook in v0.1 (spec §18.1). */
export const USER_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'BeforeStep',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'TurnEnd',
  'SessionEnd',
] as const;

export type HookEvent = (typeof USER_HOOK_EVENTS)[number];

/**
 * Names reserved for the kernel. A configuration file naming one of these is
 * rejected loudly rather than being silently ignored, because someone writing it
 * believes they have installed a security control.
 */
export const TRUSTED_KERNEL_HOOKS = [
  'PreModelRequest',
  'PreNetworkEgress',
  'PreTelemetryExport',
  'PreSecretInjection',
] as const;

export interface HookDefinition {
  event: HookEvent;
  /** Glob matched against the tool name, for PreToolUse / PostToolUse. */
  matcher?: string;
  command: string[];
  timeoutMs: number;
  permissionProfile?: string;
  /** Hook stdout is injected into the conversation when true. */
  injectOutput: boolean;
  source: string;
}

export interface HookLoadResult {
  hooks: HookDefinition[];
  warnings: string[];
}

export async function loadHooks(
  workspaceRoot: string,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<HookLoadResult> {
  let file = '';
  let content: string | undefined;
  for (const dir of projectDirCandidates(workspaceRoot)) {
    file = path.join(dir, 'hooks.toml');
    try {
      content = await readFileImpl(file);
      break;
    } catch {
      content = undefined;
    }
  }
  if (content === undefined) return { hooks: [], warnings: [] };

  let table: TomlTable;
  try {
    table = parseToml(content);
  } catch (e) {
    const detail = e instanceof TomlParseError ? e.message : 'parse error';
    return { hooks: [], warnings: [`hooks.toml could not be parsed (${detail}); no hooks were loaded`] };
  }

  return parseHookTable(table, file);
}

export function parseHookTable(table: TomlTable, source: string): HookLoadResult {
  const warnings: string[] = [];
  const hooks: HookDefinition[] = [];

  const raw = table.hooks;
  const entries: TomlValue[] = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];

  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push(`hook #${index + 1} is not a table; ignored`);
      return;
    }
    const record = entry as TomlTable;
    const event = record.event;

    if (typeof event === 'string' && (TRUSTED_KERNEL_HOOKS as readonly string[]).includes(event)) {
      warnings.push(
        `hook #${index + 1} targets "${event}", which is a trusted kernel hook and cannot be ` +
          'implemented by project configuration. It was ignored.',
      );
      return;
    }
    if (typeof event !== 'string' || !(USER_HOOK_EVENTS as readonly string[]).includes(event)) {
      warnings.push(`hook #${index + 1} has an unknown event "${String(event)}"; ignored`);
      return;
    }

    const command = Array.isArray(record.command)
      ? record.command.filter((c): c is string => typeof c === 'string')
      : [];
    if (command.length === 0) {
      warnings.push(`hook #${index + 1} has no command array; ignored`);
      return;
    }

    const hook: HookDefinition = {
      event: event as HookEvent,
      command,
      timeoutMs: typeof record.timeout_ms === 'number' ? record.timeout_ms : 30_000,
      injectOutput: record.inject_output === true,
      source,
    };
    if (typeof record.matcher === 'string') hook.matcher = record.matcher;
    if (typeof record.permission_profile === 'string') hook.permissionProfile = record.permission_profile;

    hooks.push(hook);
  });

  return { hooks, warnings };
}

export interface HookContext {
  event: HookEvent;
  /** Tool name for PreToolUse / PostToolUse. */
  toolName?: string;
  /** Substituted into `{path}` placeholders. */
  path?: string;
  sessionId: string;
  turnId?: string;
}

export interface HookOutcome {
  hook: HookDefinition;
  ran: boolean;
  exitCode?: number | null;
  /** Redacted, truncated stdout. */
  output?: string;
  blocked?: string;
  durationMs?: number;
}

export interface HookRunnerOptions {
  backend: ExecutionBackend;
  policy: PolicyEngine;
  workspaceRoot: CanonicalPath;
  agentTmpDir?: CanonicalPath;
  logger: Logger;
  now(): number;
}

export class HookRunner {
  private readonly hooks: HookDefinition[];
  private readonly opts: HookRunnerOptions;
  /** Hooks the user has approved to run at least once this session. */
  private readonly enabled = new Set<string>();

  constructor(hooks: readonly HookDefinition[], opts: HookRunnerOptions) {
    this.hooks = [...hooks];
    this.opts = opts;
  }

  /**
   * The same hooks, judged by a narrower policy (alpha.4 §27).
   *
   * A delegated child runs the project's hooks — there is deliberately no second
   * hook implementation — but a hook firing inside a read-only child must not be
   * able to do what the child cannot. Rather than teach `run()` about delegation,
   * the child gets a runner built from the same definitions and its own engine,
   * so containment comes from the engine it was handed and not from a flag it
   * could be constructed without.
   *
   * `enabled` is deliberately not shared: an approval the user gave for a hook in
   * the root scope is not an approval for the same command inside a child.
   */
  withPolicy(policy: PolicyEngine): HookRunner {
    return new HookRunner(this.hooks, { ...this.opts, policy });
  }

  forEvent(ctx: HookContext): HookDefinition[] {
    return this.hooks.filter((h) => {
      if (h.event !== ctx.event) return false;
      if (h.matcher === undefined) return true;
      if (ctx.toolName === undefined) return false;
      return globMatch(h.matcher, ctx.toolName);
    });
  }

  markEnabled(hook: HookDefinition): void {
    this.enabled.add(hookKey(hook));
  }

  isEnabled(hook: HookDefinition): boolean {
    return this.enabled.has(hookKey(hook));
  }

  /**
   * Run every hook registered for an event.
   *
   * A hook that is denied by policy does not fail the turn — it is reported. A
   * project hook is a convenience; letting it block the kernel would make
   * `.agent/hooks.toml` a denial-of-service vector on the user's own session.
   */
  async run(ctx: HookContext, signal?: AbortSignal): Promise<HookOutcome[]> {
    const outcomes: HookOutcome[] = [];

    for (const hook of this.forEvent(ctx)) {
      const argv = hook.command.map((part) =>
        part.replace(/\{path\}/g, ctx.path ?? '').replace(/\{tool\}/g, ctx.toolName ?? ''),
      );
      const executable = argv[0] ?? '';

      const accesses: AccessRequest[] = [
        {
          kind: 'process.exec',
          executable,
          argv,
          cwd: this.opts.workspaceRoot,
          display: argv.join(' ').slice(0, 200),
        },
      ];

      const decisions = this.opts.policy.decideBatch(accesses);
      const action = PolicyEngine.combine(decisions);

      if (action !== 'allow') {
        // `ask` is treated as "not now": a hook must never interrupt the user
        // with a prompt they did not initiate.
        const reason =
          action === 'ask'
            ? `hook "${hook.event}" requires approval and was not run; enable it with /permissions`
            : decisionToError(decisions.find((d) => d.action === action)!).message;
        outcomes.push({ hook, ran: false, blocked: reason });
        this.opts.logger.debug('hook blocked', { event: hook.event, action });
        continue;
      }

      const planner = new SandboxPlanner({
        workspaceRoot: this.opts.workspaceRoot,
        ...(this.opts.agentTmpDir ? { agentTmpDir: this.opts.agentTmpDir } : {}),
        timeoutMs: hook.timeoutMs,
      });
      const plan = planner.plan(decisions);
      const executor = await this.opts.backend.enforce(plan.profile);

      const started = this.opts.now();
      try {
        const result = await executor.exec(
          { argv, cwd: this.opts.workspaceRoot, timeoutMs: hook.timeoutMs },
          signal,
        );
        // Hook output is redacted by the process backend before it gets here.
        const output = truncateForModel(result.stdout + (result.stderr ? `\n${result.stderr}` : ''), {
          maxBytes: 8 * 1024,
          maxLines: 100,
        }).text;

        outcomes.push({
          hook,
          ran: true,
          exitCode: result.exitCode,
          output,
          durationMs: this.opts.now() - started,
        });
      } catch (e) {
        outcomes.push({
          hook,
          ran: false,
          blocked: e instanceof Error ? e.message : 'hook failed to start',
        });
      } finally {
        executor.dispose();
      }
    }

    return outcomes;
  }
}

function hookKey(hook: HookDefinition): string {
  return `${hook.event}:${hook.matcher ?? '*'}:${hook.command.join(' ')}`;
}

/** Hook output worth showing the model, formatted for injection. */
export function renderHookOutput(outcomes: readonly HookOutcome[]): string | undefined {
  const useful = outcomes.filter((o) => o.ran && o.hook.injectOutput && (o.output ?? '').trim() !== '');
  if (useful.length === 0) return undefined;
  return useful.map((o) => `[hook ${o.hook.event} exit ${o.exitCode ?? 'null'}]\n${o.output}`).join('\n\n');
}
