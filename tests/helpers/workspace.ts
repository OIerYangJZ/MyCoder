/**
 * Test harness: a disposable workspace plus a fully wired kernel.
 *
 * Everything is real except the model and the network — the same policy engine,
 * the same executor, the same filesystem code path. A security test that stubs
 * the component it is testing proves nothing, so the only substitutions here are
 * the two that would otherwise reach outside the machine.
 */

import { chmod, mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createKernel, type Kernel } from '../../src/kernel.ts';
import { FakeModel, type FakeResponder, type FakeStep } from '../../src/model/adapters/fake.ts';
import { ScriptedPrompter } from '../../src/cli/prompter.ts';
import type { ApprovalOutcome } from '../../src/tools/runtime.ts';
import type { EgressRequest, EgressResponse, EgressTransport } from '../../src/security/egress-gate.ts';

/** The canary from spec §26.1. */
export const CANARY = 'CANARY_SECRET_7f3e9c2a';

/** Captures every byte that would have left the machine. */
export class CapturingTransport implements EgressTransport {
  readonly sent: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  response: EgressResponse = { status: 200, headers: {}, body: '{}' };

  async send(req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<EgressResponse> {
    this.sent.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      ...(req.body ? { body: req.body } : {}),
    });
    return this.response;
  }

  /** Every captured payload, headers included, as one searchable string. */
  everything(): string {
    return this.sent.map((s) => `${s.url}\n${JSON.stringify(s.headers)}\n${s.body ?? ''}`).join('\n');
  }
}

export interface TestWorkspaceOptions {
  files?: Record<string, string>;
  /** Symlinks to create, as `linkPath -> target`. */
  symlinks?: Record<string, string>;
  script?: FakeStep[];
  /**
   * Decide each response from the request itself.
   *
   * Required once a test involves delegation: parent and child sample the *same*
   * runtime, so a flat script would have to encode the interleaving of two
   * conversations and would break the moment either changed length. A responder
   * can branch on what it is being asked — which is also how it can assert that
   * the child's request really is the child's.
   */
  responder?: FakeResponder;
  approvals?: ApprovalOutcome[];
  /** Register the canary value with the secret broker, as a user would. */
  registerCanary?: boolean;
  profile?: string;
  /**
   * Contents of the *user* `config.toml`, written before the kernel boots.
   *
   * Provider endpoints and credential sources may only be declared in user
   * config, so anything testing them has to place a real file here rather than
   * passing an override — the test would otherwise exercise a path the product
   * does not have.
   */
  userConfig?: string;
  /**
   * Files created outside the workspace, relative to the temp base.
   *
   * `[path, contents, mode]`. A credential file has to live outside the
   * workspace to be accepted at all, and its mode is the thing under test, so
   * both are part of the fixture rather than something the test fixes up after.
   */
  outsideFiles?: Array<[string, string, number?]>;
  logLevel?: 'silent' | 'trace';
  /** Collects the debug log instead of dropping it. */
  captureLog?: string[];
  /** Slows the fake stream, so a cancellation has something to interrupt. */
  chunkDelayMs?: number;
  /**
   * Resolver for the `WebFetch` address check.
   *
   * Defaulted to a fixed global address rather than the real DNS: the check under
   * test is "what does the kernel do with the answer", and using the machine's
   * resolver would make the suite assert something about the developer's network
   * — on this one, every public name resolves into RFC 2544 space.
   */
  webLookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** Extra CLI-level overrides, for tests that need a resumed session. */
  resumeSessionId?: string;
  store?: import('../../src/session/store.ts').SessionStore;
  /**
   * Execution backend for this workspace (alpha.5).
   *
   * `'container'` boots the *same* kernel against `ContainerExecutionBackend`,
   * which is the point: the composition suites (§43–§47) have to prove that
   * Subagent, Skill, Hook, replay and resume behave identically on a backend they
   * know nothing about. It requires a working Docker runtime and throws if there
   * is none — see `containerAvailable()`, which is how the suites skip rather than
   * fail on a machine without one.
   */
  backend?: 'local' | 'container' | 'linux-native';
}

export interface TestWorkspace {
  root: string;
  /** The temp directory containing `workspace/`, `home/` and `kernel-dirs/`. */
  base: string;
  kernel: Kernel;
  fakeModel: FakeModel;
  transport: CapturingTransport;
  prompter: ScriptedPrompter;
  file(rel: string): Promise<string>;
  write(rel: string, content: string): Promise<void>;
  /** Every persisted event as one searchable string. */
  eventLogText(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createTestWorkspace(opts: TestWorkspaceOptions = {}): Promise<TestWorkspace> {
  const base = await mkdtemp(path.join(tmpdir(), 'agent-kernel-test-'));
  const root = path.join(base, 'workspace');
  const home = path.join(base, 'home');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });

  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }

  for (const [link, target] of Object.entries(opts.symlinks ?? {})) {
    const full = path.join(root, link);
    await mkdir(path.dirname(full), { recursive: true });
    await symlink(path.isAbsolute(target) ? target : path.join(root, target), full);
  }

  for (const [rel, content, mode] of opts.outsideFiles ?? []) {
    const full = path.join(base, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    if (mode !== undefined) await chmod(full, mode);
  }

  const dirsRoot = path.join(base, 'kernel-dirs');
  if (opts.userConfig !== undefined) {
    await mkdir(path.join(dirsRoot, 'config'), { recursive: true });
    // `{{base}}` expands to the temp root. Config values like `api_key_file`
    // have to be absolute to be realistic — a relative one anchors to the
    // config directory — and the temp root is only known at run time.
    await writeFile(
      path.join(dirsRoot, 'config', 'config.toml'),
      opts.userConfig.replaceAll('{{base}}', base),
      'utf8',
    );
  }

  const fakeModel = new FakeModel({
    script: opts.script ?? [],
    ...(opts.responder ? { responder: opts.responder } : {}),
    ...(opts.chunkDelayMs !== undefined ? { chunkDelayMs: opts.chunkDelayMs } : {}),
  });
  const transport = new CapturingTransport();
  const prompter = new ScriptedPrompter(opts.approvals ?? []);

  const kernel = await createKernel({
    workspaceDir: root,
    dirsRoot,
    ...(opts.profile ? { profileOverride: opts.profile } : {}),
    fakeModel,
    egressTransport: transport,
    prompter,
    logLevel: opts.logLevel ?? 'silent',
    ...(opts.captureLog ? { logSink: (line: string) => opts.captureLog!.push(line) } : {}),
    ...(opts.store ? { store: opts.store } : {}),
    webLookup: opts.webLookup ?? (async () => [{ address: '93.184.216.34', family: 4 }]),
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    ...(opts.backend ? { backend: opts.backend } : {}),
  });

  if (opts.registerCanary !== false) {
    kernel.secrets.register('test/canary', { kind: 'literal', value: CANARY });
  }

  return {
    root,
    base,
    kernel,
    fakeModel,
    transport,
    prompter,

    async file(rel: string) {
      return readFile(path.join(root, rel), 'utf8');
    },

    async write(rel: string, content: string) {
      const full = path.join(root, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    },

    async eventLogText() {
      const parts: string[] = [];
      for await (const event of kernel.store.readEvents(kernel.sessionId)) {
        parts.push(JSON.stringify(event));
      }
      return parts.join('\n');
    },

    async cleanup() {
      await kernel.shutdown();
      await removeWithRetry(base);
    },
  };
}

/**
 * Remove a temp tree, tolerating a bind mount that has not finished going away.
 *
 * `docker run --rm` returns when the *container* exits; the daemon unmounts the
 * bind afterwards, and on Docker Desktop that lag is measurable — under a
 * parallel suite, `rmdir` of a directory that was a mount target returns
 * `EACCES` on macOS rather than `EBUSY`, which reads like a permissions bug and
 * is not one.
 *
 * Retried rather than ignored: swallowing the error would leave temp trees
 * behind on every run, and asserting on the first attempt would make the
 * container suites flaky in exactly the configuration CI uses.
 */
async function removeWithRetry(target: string, attempts = 10): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i === attempts - 1 || (code !== 'EACCES' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw e;
      await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
    }
  }
}

/**
 * An agent definition file, for a workspace that will delegate.
 *
 * Written as project content — `.mycoder/agents/<name>.md` — rather than injected
 * through an option, because discovery is part of what the delegation tests are
 * checking: an agent the kernel did not find is an agent that cannot be
 * dispatched.
 */
export function agentFile(input: {
  name: string;
  description?: string;
  profile?: string;
  tools?: string[];
  model?: string;
  maxSteps?: number;
  maxToolCalls?: number;
  skills?: string[];
  instructions?: string;
}): string {
  const front = [
    '---',
    `name: ${input.name}`,
    `description: ${input.description ?? `test agent ${input.name}`}`,
    ...(input.profile ? [`permission_profile: ${input.profile}`] : []),
    ...(input.tools ? [`tools: [${input.tools.join(', ')}]`] : []),
    ...(input.model ? [`model: ${input.model}`] : []),
    ...(input.maxSteps !== undefined ? [`max_steps: ${input.maxSteps}`] : []),
    ...(input.maxToolCalls !== undefined ? [`max_tool_calls: ${input.maxToolCalls}`] : []),
    ...(input.skills ? [`skills: [${input.skills.join(', ')}]`] : []),
    '---',
    '',
  ];
  return `${front.join('\n')}${input.instructions ?? `You are the ${input.name} test agent.`}\n`;
}

/** A `SKILL.md`, likewise written as real project content. */
export function skillFile(input: {
  name: string;
  description?: string;
  profile?: string;
  tools?: string[];
  maxSteps?: number;
  instructions?: string;
  extraFrontmatter?: string[];
}): string {
  const front = [
    '---',
    `name: ${input.name}`,
    `description: ${input.description ?? `test skill ${input.name}`}`,
    ...(input.profile ? [`permission_profile: ${input.profile}`] : []),
    ...(input.tools ? [`tools: [${input.tools.join(', ')}]`] : []),
    ...(input.maxSteps !== undefined ? [`max_steps: ${input.maxSteps}`] : []),
    ...(input.extraFrontmatter ?? []),
    '---',
    '',
  ];
  return `${front.join('\n')}${input.instructions ?? `Follow the ${input.name} procedure.`}\n`;
}

/** A Delegate step for the fake model. */
export function delegateStep(agent: string, task: string, extra: Record<string, unknown> = {}): FakeStep {
  return { kind: 'tools', calls: [{ name: 'Delegate', arguments: { agent, task, ...extra } }] };
}

/** True when this model request is the one a given subagent made. */
export function isChildRequest(request: { system: string }, agent: string): boolean {
  return request.system.includes(`the subagent "${agent}"`);
}

/** Convenience: a Read step for the fake model. */
export function readStep(file: string, offsetLine?: number, limitLines?: number): FakeStep {
  return {
    kind: 'tools',
    calls: [
      {
        name: 'Read',
        arguments: {
          path: file,
          ...(offsetLine !== undefined ? { offsetLine } : {}),
          ...(limitLines !== undefined ? { limitLines } : {}),
        },
      },
    ],
  };
}

export function shellStep(argv: string[]): FakeStep {
  return { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv } }] };
}

export function grepStep(pattern: string, glob?: string): FakeStep {
  return {
    kind: 'tools',
    calls: [{ name: 'Grep', arguments: { pattern, ...(glob ? { glob } : {}) } }],
  };
}

/**
 * Pull a receiptId out of the last Read result.
 *
 * The fake model is scripted, so an Edit step needs the receipt the previous
 * Read produced. This mirrors what a real model does by reading the header.
 */
export function receiptFromContext(kernel: Kernel, filePath: string): string | undefined {
  const receipts = kernel.freshness.list();
  const match = receipts.find((r) => r.path.endsWith(filePath));
  return match?.receiptId;
}
