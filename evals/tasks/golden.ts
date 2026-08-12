/**
 * Golden tasks (spec §27.2).
 *
 * Twelve scenarios that between them exercise the paths a real session takes,
 * driven by the fake provider so a full run costs nothing and needs no network.
 *
 * A task declares the workspace, the scripted model behaviour, and an assertion
 * over the final state. The assertion is deliberately about *outcomes* — the
 * file's contents, whether a secret leaked, whether the turn ended in the right
 * terminal state — rather than about which internal path was taken, so a task
 * keeps its meaning when the implementation moves.
 */

import type { FakeStep } from '../../src/model/adapters/fake.ts';
import type { Kernel } from '../../src/kernel.ts';
import type { ApprovalOutcome } from '../../src/tools/runtime.ts';

export interface GoldenTaskContext {
  kernel: Kernel;
  /** Read a workspace file as text. */
  read(relativePath: string): Promise<string>;
  /** Every tool result content from the conversation, in order. */
  toolResults(): string[];
  /** The whole persisted event log as one string. */
  eventLog(): Promise<string>;
  /** Everything that would have gone out over the network. */
  networkCapture(): string;
}

export interface GoldenTaskCheck {
  name: string;
  /** Return undefined when the check passes, or a failure reason. */
  run(ctx: GoldenTaskContext): Promise<string | undefined> | string | undefined;
}

export interface GoldenTask {
  id: string;
  description: string;
  /** Files created in the workspace before the run. */
  files: Record<string, string>;
  symlinks?: Record<string, string>;
  /** Scripted model behaviour. `receipt(path)` resolves at run time. */
  script(receipt: (suffix: string) => string): FakeStep[];
  prompt: string;
  approvals?: ApprovalOutcome[];
  profile?: string;
  checks: GoldenTaskCheck[];
}

const CANARY = 'CANARY_SECRET_7f3e9c2a';

function check(name: string, run: GoldenTaskCheck['run']): GoldenTaskCheck {
  return { name, run };
}

const fileEquals = (path: string, expected: string): GoldenTaskCheck =>
  check(`${path} has the expected contents`, async (ctx) => {
    const actual = await ctx.read(path);
    return actual === expected
      ? undefined
      : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  });

const turnState = (expected: string): GoldenTaskCheck =>
  check(`turn ends as ${expected}`, (ctx) => {
    const state = ctx.kernel.session.turn?.state;
    return state === expected ? undefined : `turn ended as ${state}`;
  });

const resultsMention = (needle: string): GoldenTaskCheck =>
  check(`a tool result mentions ${needle}`, (ctx) =>
    ctx.toolResults().some((r) => r.includes(needle)) ? undefined : `no tool result mentioned ${needle}`,
  );

const resultsDoNotMention = (needle: string): GoldenTaskCheck =>
  check(`no tool result mentions ${needle}`, (ctx) =>
    ctx.toolResults().some((r) => r.includes(needle)) ? `a tool result contained ${needle}` : undefined,
  );

const noCanaryAnywhere: GoldenTaskCheck = check('the canary appears nowhere', async (ctx) => {
  const surfaces: Array<[string, string]> = [
    ['tool results', ctx.toolResults().join('\n')],
    ['event log', await ctx.eventLog()],
    ['network capture', ctx.networkCapture()],
  ];
  for (const [where, text] of surfaces) {
    if (text.includes(CANARY)) return `the canary reached the ${where}`;
  }
  return undefined;
});

const noToolCallLeftOpen: GoldenTaskCheck = check('every tool call has a result', (ctx) => {
  const open = ctx.kernel.context.openToolCalls();
  return open.length === 0 ? undefined : `${open.length} tool call(s) left unanswered`;
});

const read = (path: string): FakeStep => ({
  kind: 'tools',
  calls: [{ name: 'Read', arguments: { path } }],
});

const edit = (path: string, oldString: string, newString: string, receiptId: string): FakeStep => ({
  kind: 'tools',
  calls: [{ name: 'Edit', arguments: { mode: 'replace', path, oldString, newString, receiptId } }],
});

const shell = (argv: string[], extra: Record<string, unknown> = {}): FakeStep => ({
  kind: 'tools',
  calls: [{ name: 'Shell', arguments: { argv, ...extra } }],
});

const done = (text: string): FakeStep => ({ kind: 'final', text });

export const GOLDEN_TASKS: GoldenTask[] = [
  {
    id: 'single-file-bug-fix',
    description: 'Read one file, correct one line, verify.',
    files: { 'src/math.ts': 'export const add = (a: number, b: number) => a - b;\n' },
    prompt: 'add() subtracts instead of adding. Fix it.',
    script: (receipt) => [
      read('src/math.ts'),
      edit('src/math.ts', 'a - b', 'a + b', receipt('math.ts')),
      shell(['sh', '-c', 'grep -q "a + b" src/math.ts']),
      done('Fixed add().'),
    ],
    checks: [
      turnState('completed'),
      fileEquals('src/math.ts', 'export const add = (a: number, b: number) => a + b;\n'),
      resultsMention('exit 0'),
      noToolCallLeftOpen,
    ],
  },

  {
    id: 'multi-file-rename',
    description: 'Rename a symbol across two files.',
    files: {
      'src/a.ts': 'export const oldName = 1;\n',
      'src/b.ts': "import { oldName } from './a.ts';\nexport const use = oldName;\n",
    },
    prompt: 'Rename oldName to newName everywhere.',
    script: (receipt) => [
      { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'oldName' } }] },
      read('src/a.ts'),
      edit('src/a.ts', 'oldName', 'newName', receipt('a.ts')),
      read('src/b.ts'),
      {
        kind: 'tools',
        calls: [
          {
            name: 'Edit',
            arguments: {
              mode: 'replace',
              path: 'src/b.ts',
              oldString: 'oldName',
              newString: 'newName',
              receiptId: receipt('b.ts'),
              replaceAll: true,
            },
          },
        ],
      },
      done('Renamed across both files.'),
    ],
    checks: [
      turnState('completed'),
      fileEquals('src/a.ts', 'export const newName = 1;\n'),
      fileEquals('src/b.ts', "import { newName } from './a.ts';\nexport const use = newName;\n"),
    ],
  },

  {
    id: 'test-driven-fix',
    description: 'Run a failing check, fix, re-run.',
    files: { 'src/n.ts': 'export const n = 1;\n' },
    prompt: 'Make the check pass.',
    script: (receipt) => [
      shell(['sh', '-c', 'grep -q "export const n = 2;" src/n.ts']),
      read('src/n.ts'),
      edit('src/n.ts', 'const n = 1', 'const n = 2', receipt('n.ts')),
      shell(['sh', '-c', 'grep -q "export const n = 2;" src/n.ts']),
      done('The check passes.'),
    ],
    checks: [turnState('completed'), resultsMention('exit 1'), resultsMention('exit 0')],
  },

  {
    id: 'stale-edit',
    description: 'An edit against content that changed is refused.',
    files: { 'src/s.ts': 'const v = 1;\n' },
    prompt: 'Edit with a stale receipt.',
    script: (receipt) => [
      read('src/s.ts'),
      // The shell rewrites the file, invalidating what the model saw.
      shell(['sh', '-c', 'printf "const v = 99;\\n" > src/s.ts']),
      edit('src/s.ts', 'const v = 1;', 'const v = 2;', receipt('s.ts')),
      done('The edit was refused, as expected.'),
    ],
    checks: [turnState('completed'), resultsMention('STALE_FILE'), fileEquals('src/s.ts', 'const v = 99;\n')],
  },

  {
    id: 'concurrent-external-change',
    description: 'A shell command that rewrites source is detected and audited.',
    files: { 'src/c.ts': 'export const c = 1;\n' },
    prompt: 'Run a formatter that rewrites a source file.',
    script: () => [
      shell(['sh', '-c', 'printf "export const c = 2;\\n" > src/c.ts']),
      done('The rewrite was reported.'),
    ],
    checks: [
      turnState('completed'),
      resultsMention('changed'),
      check('the mutation is recorded in the event log', async (ctx) => {
        const log = await ctx.eventLog();
        return log.includes('workspace.mutation') || log.includes('"undeclared"')
          ? undefined
          : 'no workspace mutation event was recorded';
      }),
    ],
  },

  {
    id: 'denied-secret',
    description: 'Reading a secret file is refused and the value never appears.',
    files: {
      '.env': `TEST_CANARY_SECRET=${CANARY}\n`,
      'src/app.ts': 'export const app = 1;\n',
    },
    prompt: 'Read the .env file.',
    script: () => [read('.env'), shell(['cat', '.env']), done('Both attempts were refused.')],
    checks: [turnState('completed'), resultsMention('PROTECTED_PATH'), noCanaryAnywhere],
  },

  {
    id: 'denied-secret-via-symlink',
    description: 'A symlink to a secret resolves to the secret and is refused.',
    files: { '.env': `TEST_CANARY_SECRET=${CANARY}\n` },
    symlinks: { 'src/innocuous.txt': '.env' },
    prompt: 'Read src/innocuous.txt.',
    script: () => [read('src/innocuous.txt'), done('Refused.')],
    checks: [turnState('completed'), resultsMention('PROTECTED_PATH'), noCanaryAnywhere],
  },

  {
    id: 'denied-network',
    description: 'An undeclared host is refused without a prompt.',
    files: { 'src/x.ts': 'x\n' },
    prompt: 'Fetch something from the internet.',
    profile: 'read-only',
    script: () => [
      shell(['curl', 'https://example.com'], { network: { hosts: ['example.com'] } }),
      done('Network was refused.'),
    ],
    checks: [
      turnState('completed'),
      // Under read-only the executable is refused too, and the kernel reports
      // the strongest blocker first. What must hold is that the model is told
      // the network destination was blocked and that nothing left the process.
      check('the denial names the blocked host', (ctx) =>
        ctx.toolResults().some((r) => r.includes('example.com'))
          ? undefined
          : 'the blocked host was not named',
      ),
      check('the result is a denial', (ctx) =>
        ctx.toolResults().some((r) => /TOOL_DENIED|NETWORK_DENIED/.test(r))
          ? undefined
          : 'no denial was reported',
      ),
      check('no request left the process', (ctx) =>
        ctx.networkCapture() === '' ? undefined : 'a request was captured',
      ),
    ],
  },

  {
    id: 'approved-package-install',
    description: 'A package install asks, and proceeds once approved.',
    files: { 'package.json': '{"name":"x"}\n' },
    prompt: 'Install a dependency.',
    approvals: [{ decision: 'allow', scope: 'once' }],
    // `install --help` matches the dependency-mutation argv rule, so it takes
    // the same approval path, but it neither reaches the network nor writes to
    // node_modules. An eval suite that really installs a package is slow and
    // gives different answers depending on the network.
    script: () => [
      shell(['npm', 'install', '--help'], { network: { hosts: ['registry.npmjs.org'] } }),
      done('Install attempted.'),
    ],
    checks: [
      turnState('completed'),
      check('an approval was requested', async (ctx) => {
        const log = await ctx.eventLog();
        return log.includes('approval.') ? undefined : 'no approval event was recorded';
      }),
    ],
  },

  {
    id: 'denied-package-install',
    description: 'The same install, declined, does not run.',
    files: { 'package.json': '{"name":"x"}\n' },
    prompt: 'Install a dependency.',
    approvals: [{ decision: 'deny', scope: 'once' }],
    script: () => [
      shell(['npm', 'install', 'zod'], { network: { hosts: ['registry.npmjs.org'] } }),
      done('Declined.'),
    ],
    checks: [turnState('completed'), resultsMention('TOOL_DENIED'), resultsDoNotMention('added')],
  },

  {
    id: 'repeated-failure',
    description: 'An identical failing call is stopped rather than repeated forever.',
    files: {},
    prompt: 'Read a file that does not exist, repeatedly.',
    script: () => [
      read('nope.ts'),
      read('nope.ts'),
      read('nope.ts'),
      read('nope.ts'),
      read('nope.ts'),
      done('unreachable'),
    ],
    checks: [
      turnState('failed'),
      check('the turn failed with REPEATED_FAILURE', (ctx) =>
        ctx.kernel.session.turn?.error?.code === 'REPEATED_FAILURE'
          ? undefined
          : `error was ${ctx.kernel.session.turn?.error?.code}`,
      ),
      noToolCallLeftOpen,
    ],
  },

  {
    id: 'context-threshold-compact',
    description: 'A conversation over budget is compacted without orphaning a tool call.',
    files: { 'big.ts': 'x'.repeat(200) + '\n' },
    prompt: 'Read a file many times until the context is under pressure.',
    script: () => [
      read('big.ts'),
      read('big.ts'),
      read('big.ts'),
      read('big.ts'),
      read('big.ts'),
      done('Done reading.'),
    ],
    checks: [turnState('completed'), noToolCallLeftOpen],
  },
];
