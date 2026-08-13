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
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
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

  const fakeModel = new FakeModel({ script: opts.script ?? [] });
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
      await rm(base, { recursive: true, force: true });
    },
  };
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
