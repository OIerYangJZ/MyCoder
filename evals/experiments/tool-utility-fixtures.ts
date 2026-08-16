/**
 * Fixtures for "do the alpha.7 file tools pay?" (§B).
 *
 * Three tasks, two arms. The arms differ by exactly one thing: whether `Write`,
 * `Delete` and `Move` are in the catalogue the model is shown. Everything else —
 * fixture, prompt, profile, approvals, model — is identical, which is what makes
 * a difference in steps or tokens attributable to the tools rather than to the
 * task.
 *
 * Two design rules carried over from the delegation experiment, both learned the
 * hard way there:
 *
 *   **The control must be a model that cannot see the tool.** An arm that still
 *   had `Delete` and was merely discouraged from using it would measure wording.
 *   `ToolRegistry.unregister` removes it from the frozen catalogue outright.
 *
 *   **Each arm asserts its own premise.** A `prepare` that silently failed would
 *   compare an arm against itself and produce a beautifully clean null result.
 *   Every arm checks the catalogue the first step was frozen against.
 *
 * The withheld arm's scripted trajectory is not decoration either: it is the
 * proof that these tasks are *solvable* without the new tools, using `Edit`,
 * `Shell rm` and `Shell mv`. If they were not, the comparison would be between a
 * possible task and an impossible one, and any difference would be trivial.
 */

import type { FakeStep } from '../../src/model/adapters/fake.ts';
import type { Kernel } from '../../src/kernel.ts';
import type { GoldenTask } from '../tasks/golden.ts';
import { GOLDEN_TASKS } from '../tasks/golden.ts';

export type Arm = 'tools-available' | 'tools-withheld';

/** The tools ADR-0016 added, and the ones the control arm does not get. */
export const ALPHA7_FILE_TOOLS = ['Write', 'Delete', 'Move'] as const;

export interface ToolUtilityTask extends GoldenTask {
  arm: Arm;
  /** The golden task this arm was derived from. */
  baseId: string;
}

/** The three golden tasks whose natural solution uses a new tool. */
const BASE_IDS = ['regenerate-generated-file', 'remove-dead-module', 'rename-module-file'] as const;

function base(id: string): GoldenTask {
  const task = GOLDEN_TASKS.find((t) => t.id === id);
  if (!task) throw new Error(`tool-utility: no golden task "${id}"`);
  return task;
}

/**
 * Assert the arm really is the arm — from the catalogue the model was shown.
 *
 * `session.effectiveAllowedTools` is the post-intersection view, which is what
 * `freezeStep` builds the schema list from, so this is the same set the model
 * saw rather than a proxy for it.
 */
function assertCatalogue(kernel: Kernel, arm: Arm): void {
  const names = new Set(kernel.session.effectiveAllowedTools);
  for (const tool of ALPHA7_FILE_TOOLS) {
    const present = names.has(tool);
    if (arm === 'tools-available' && !present) {
      throw new Error(`tool-utility: arm "${arm}" is missing ${tool}; the measurement would be meaningless`);
    }
    if (arm === 'tools-withheld' && present) {
      throw new Error(`tool-utility: arm "${arm}" still offers ${tool}; the control did not take effect`);
    }
  }
}

/** How each task is solved when the new tools are absent. */
const WITHHELD_SCRIPTS: Record<string, (receipt: (suffix: string) => string) => FakeStep[]> = {
  'regenerate-generated-file': (receipt) => [
    { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/routes.ts' } }] },
    { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'generated/routes.json' } }] },
    {
      kind: 'tools',
      calls: [
        {
          name: 'Edit',
          arguments: {
            mode: 'replace',
            path: 'generated/routes.json',
            oldString: '["/", "/about"]',
            newString: '["/", "/about", "/pricing", "/contact"]',
            receiptId: receipt('routes.json'),
          },
        },
      ],
    },
    { kind: 'final', text: 'Regenerated the route manifest with an exact replace.' },
  ],

  'remove-dead-module': (receipt) => [
    { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'legacy' } }] },
    { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/app.ts' } }] },
    {
      kind: 'tools',
      calls: [
        {
          name: 'Edit',
          arguments: {
            mode: 'replace',
            path: 'src/app.ts',
            oldString:
              "import { legacyFlag } from './legacy.ts';\n\nexport const start = () => (legacyFlag ? 'old' : 'new');",
            newString: "export const start = () => 'new';",
            receiptId: receipt('app.ts'),
          },
        },
      ],
    },
    // The pre-ADR-0016 way to remove a file: an approval for *running a program*.
    { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['rm', 'src/legacy.ts'] } }] },
    { kind: 'final', text: 'Removed the dead module with rm.' },
  ],

  'rename-module-file': (receipt) => [
    {
      kind: 'tools',
      calls: [
        { name: 'Shell', arguments: { argv: ['mv', 'src/helpers/str-utils.ts', 'src/helpers/text.ts'] } },
      ],
    },
    { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/index.ts' } }] },
    {
      kind: 'tools',
      calls: [
        {
          name: 'Edit',
          arguments: {
            mode: 'replace',
            path: 'src/index.ts',
            oldString: './helpers/str-utils.ts',
            newString: './helpers/text.ts',
            receiptId: receipt('index.ts'),
          },
        },
      ],
    },
    { kind: 'final', text: 'Renamed with mv and updated the import.' },
  ],
};

export function toolUtilityTasks(): ToolUtilityTask[] {
  const out: ToolUtilityTask[] = [];

  for (const id of BASE_IDS) {
    const task = base(id);

    for (const arm of ['tools-available', 'tools-withheld'] as const) {
      const withheld = arm === 'tools-withheld';
      out.push({
        ...task,
        id: `${id}--${arm}`,
        baseId: id,
        arm,
        // Both arms answer approvals the same way. The *reason* differs — a
        // `file.delete` in one arm, a `process.exec` in the other — and the
        // prompt count is one of the things being compared.
        approvals: [{ decision: 'allow', scope: 'session' }],
        ...(withheld ? { script: WITHHELD_SCRIPTS[id]! } : {}),
        prepare: (kernel: Kernel) => {
          if (withheld) {
            for (const tool of ALPHA7_FILE_TOOLS) kernel.toolRegistry.unregister(tool);
          }
          assertCatalogue(kernel, arm);
        },
      });
    }
  }

  return out;
}
