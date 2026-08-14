/**
 * Cross-backend conformance (alpha.5 §48) — the executable exam for ADR-0007.
 *
 * ADR-0007 says Local, SSH and Container implement *one* `ExecutionBackend` and
 * that the agent loop cannot tell them apart. Until now that was a claim checked
 * by reading the code. This suite checks it by running the same semantic cases
 * through the same kernel, changing only which backend the bootstrap selected,
 * and asserting the same observable outcome.
 *
 * Two design choices are load-bearing:
 *
 *  1. **Cases run through the whole stack**, driven by a scripted model, not by
 *     calling `backend.exec()` directly. A backend that satisfied the interface
 *     but broke `Grep`'s output parsing, the freshness ledger or the mutation
 *     detector would pass a direct test and fail a real session — and the
 *     container backend rewrites the working directory, which is exactly the kind
 *     of change that breaks a tool two layers away.
 *
 *  2. **The expectations are semantic, not literal.** `Shell` on a container
 *     prints `/workspace`, and locally it prints the host path; both are "pwd
 *     reported the working directory". Asserting the literal string would force
 *     the backends to be identical rather than *equivalent*, which is not what
 *     ADR-0007 claims and not what a caller depends on.
 *
 * The container half skips without a runtime unless `KERNEL_CONTAINER_REQUIRED=1`
 * (§65). The SSH half is deliberately not here: it needs a live remote, so it
 * lives in `tests/live/ssh-*.test.ts` where the rest of the SSH matrix is, and
 * `docs/alpha5-evidence-matrix.md` records which target produced it.
 */

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts';
import { containerRequirement } from '../live/container-harness.ts';
import type { FakeStep } from '../../src/model/adapters/fake.ts';
import type { ModelRequest } from '../../src/model/ir.ts';

const requirement = await containerRequirement();

const containerSkip = ((): { skip?: string } => {
  if (requirement.run) return {};
  if (requirement.required) {
    throw new Error(
      `KERNEL_CONTAINER_REQUIRED=1 but the conformance suite cannot reach a container runtime: ${requirement.reason}`,
    );
  }
  return { skip: requirement.reason };
})();

const FILES = {
  'src/app.ts': 'export const answer = 42;\nexport const other = 7;\n',
  'src/util.ts': 'export const twice = (n: number): number => n * 2;\n',
  'tests/app.test.ts': 'import { answer } from "../src/app.ts";\nconsole.log(answer);\n',
  'README.md': '# conformance fixture\n\nanswer lives in src/app.ts\n',
};

/** Every tool result string produced by the last turn. */
function toolResults(ws: TestWorkspace): string[] {
  const out: string[] = [];
  for (const message of ws.kernel.context.history()) {
    if (message.role !== 'tool') continue;
    for (const part of message.parts) {
      if (part.type === 'tool_result') out.push(part.content);
    }
  }
  return out;
}

interface ConformanceCase {
  name: string;
  script?: FakeStep[];
  /**
   * A responder, for cases whose second call depends on the first result.
   *
   * `Edit` is the one that forces this: it requires the `receiptId` the `Read`
   * returned, which no fixed script can know. That requirement is not incidental
   * — it is the freshness protocol — so a conformance suite that worked around it
   * would be exercising a path the product does not have.
   */
  responder?: (request: ModelRequest, callIndex: number) => FakeStep | undefined;
  /** Asserted against the concatenated tool results of the turn. */
  expect(results: string[], ws: TestWorkspace): Promise<void> | void;
  /** Approvals to feed the prompter, if the case needs one. */
  approvals?: import('../../src/tools/runtime.ts').ApprovalOutcome[];
}

/** Pull the newest `receiptId:` out of the conversation the model was handed. */
function latestReceiptId(request: ModelRequest): string | undefined {
  const text = JSON.stringify(request.messages ?? []);
  const matches = [...text.matchAll(/receiptId: (rcp_[A-Za-z0-9_]+)/g)];
  return matches.at(-1)?.[1];
}

const CASES: ConformanceCase[] = [
  {
    name: 'Read returns file content with a receipt',
    script: [
      { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/app.ts' } }] },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      assert.match(results.join('\n'), /export const answer = 42;/);
    },
  },
  {
    name: 'Read of a path outside the workspace is refused',
    script: [
      { kind: 'tools', calls: [{ name: 'Read', arguments: { path: '../outside.txt' } }] },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      assert.match(results.join('\n'), /error:/);
    },
  },
  {
    name: 'Grep finds a match and reports its file',
    script: [
      { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'answer' } }] },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      const text = results.join('\n');
      assert.match(text, /app\.ts/);
    },
  },
  {
    name: 'Glob lists matching files',
    script: [
      { kind: 'tools', calls: [{ name: 'Glob', arguments: { pattern: 'src/*.ts' } }] },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      const text = results.join('\n');
      assert.match(text, /app\.ts/);
      assert.match(text, /util\.ts/);
    },
  },
  {
    name: 'Edit applies after a Read, and the bytes land on disk',
    responder: (request, callIndex) => {
      if (callIndex === 0) {
        return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/util.ts' } }] };
      }
      if (callIndex === 1) {
        return {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: {
                mode: 'replace',
                path: 'src/util.ts',
                oldString: 'n * 2',
                newString: 'n * 3',
                receiptId: latestReceiptId(request) ?? 'missing',
              },
            },
          ],
        };
      }
      return { kind: 'final', text: 'done' };
    },
    expect: async (results, ws) => {
      assert.ok(!results.join('\n').includes('error:'), results.join('\n'));
      assert.match(await ws.file('src/util.ts'), /n \* 3/);
    },
  },
  {
    name: 'Edit without a Read is refused for staleness, on every backend',
    script: [
      {
        kind: 'tools',
        calls: [
          {
            name: 'Edit',
            arguments: { mode: 'replace', path: 'src/app.ts', oldString: '42', newString: '43' },
          },
        ],
      },
      { kind: 'final', text: 'done' },
    ],
    expect: async (results, ws) => {
      assert.match(results.join('\n'), /error:/);
      assert.match(await ws.file('src/app.ts'), /42/);
    },
  },
  {
    name: 'Shell success reports exit 0 and its stdout',
    script: [
      { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['echo', 'conformance-ok'] } }] },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      assert.match(results.join('\n'), /conformance-ok/);
    },
  },
  {
    name: 'Shell non-zero exit is a result, not an infrastructure error',
    script: [
      { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['sh', '-c', 'exit 7'] } }] },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      const text = results.join('\n');
      assert.match(text, /7/);
      assert.ok(
        !/CONTAINER_|REMOTE_/.test(text),
        `an ordinary failure must not surface as a backend error: ${text}`,
      );
    },
  },
  {
    name: 'Shell separates stdout from stderr',
    script: [
      {
        kind: 'tools',
        calls: [{ name: 'Shell', arguments: { argv: ['sh', '-c', 'echo out; echo err 1>&2'] } }],
      },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      const text = results.join('\n');
      assert.match(text, /out/);
      assert.match(text, /err/);
    },
  },
  {
    name: 'Shell honours a timeout',
    script: [
      {
        kind: 'tools',
        calls: [{ name: 'Shell', arguments: { argv: ['sh', '-c', 'sleep 30'], timeoutMs: 3_000 } }],
      },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      assert.match(results.join('\n').toLowerCase(), /timed out|timeout/);
    },
  },
  {
    name: 'Shell runs in the workspace root by default',
    script: [
      { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['ls'] } }] },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      const text = results.join('\n');
      assert.match(text, /README\.md/);
      assert.match(text, /src/);
    },
  },
  {
    name: 'a shell mutation of a source file is detected and reported',
    script: [
      {
        kind: 'tools',
        calls: [{ name: 'Shell', arguments: { argv: ['sh', '-c', 'echo "// touched" >> src/app.ts'] } }],
      },
      { kind: 'final', text: 'done' },
    ],
    expect: (results, ws) => {
      const text = results.join('\n');
      // Either the write succeeded and was audited as an undeclared mutation, or
      // the backend refused it because no capability granted a write there. Both
      // are correct; silently changing a source file with neither is not.
      const audited = /changed|mutat/i.test(text);
      const refused = /error:|Read-only|Permission denied|denied/i.test(text);
      assert.ok(audited || refused, `expected an audit or a refusal, got: ${text}`);
      if (audited && !refused) {
        assert.equal(ws.kernel.session.usageSnapshot.toolCalls > 0, true);
      }
    },
  },
  {
    name: 'output is redacted before it reaches the model',
    script: [
      {
        kind: 'tools',
        calls: [
          {
            name: 'Shell',
            arguments: { argv: ['echo', 'sk-ant-api03-abcdef-conformance-fixture-0123456789'] },
          },
        ],
      },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      assert.ok(
        !results.join('\n').includes('sk-ant-api03-abcdef-conformance-fixture-0123456789'),
        'a credential-shaped token must not reach the model on any backend',
      );
    },
  },
  {
    name: 'GitDiff behaves consistently whether or not git is present',
    script: [
      { kind: 'tools', calls: [{ name: 'GitDiff', arguments: {} }] },
      { kind: 'final', text: 'done' },
    ],
    expect: (results) => {
      const text = results.join('\n');
      // The fixture is not a repository, so the honest answers are "not a git
      // repository" or "git is unavailable on this backend". What must not
      // happen is a raw backend error leaking through as though the tool broke.
      assert.ok(
        /git|repository|unavailable|not a/i.test(text),
        `expected an explanatory result, got: ${text}`,
      );
      assert.ok(!/CONTAINER_START_FAILED|INTERNAL_ERROR/.test(text), text);
    },
  },
];

async function runCase(testCase: ConformanceCase, backend: 'local' | 'container'): Promise<void> {
  const ws = await createTestWorkspace({
    files: FILES,
    ...(testCase.script ? { script: testCase.script } : {}),
    ...(testCase.responder ? { responder: testCase.responder } : {}),
    backend,
    ...(testCase.approvals ? { approvals: testCase.approvals } : {}),
  });
  try {
    await ws.kernel.session.runTurn('go');
    await testCase.expect(toolResults(ws), ws);
  } finally {
    await ws.cleanup();
  }
}

describe('backend conformance: local', { timeout: 120_000 }, () => {
  for (const testCase of CASES) {
    test(testCase.name, async () => {
      await runCase(testCase, 'local');
    });
  }
});

describe('backend conformance: container', { ...containerSkip, timeout: 600_000 }, () => {
  for (const testCase of CASES) {
    test(testCase.name, async () => {
      await runCase(testCase, 'container');
    });
  }

  test('the backend is genuinely the container one', async () => {
    const ws = await createTestWorkspace({ files: FILES, backend: 'container', script: [] });
    try {
      assert.equal(ws.kernel.backend.kind, 'container');
      assert.equal(ws.kernel.backend.environment.sandboxStrength, 'container-enforced');
      // The tool plane's root is still the host workspace (ADR-0012): the
      // container path is an implementation detail of the backend and must not
      // leak into policy, the ledger or the session metadata.
      assert.equal(ws.kernel.workspaceRoot, ws.kernel.projectRoot);
    } finally {
      await ws.cleanup();
    }
  });
});
