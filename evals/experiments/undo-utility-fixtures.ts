/**
 * Fixtures for "does having undo change what the model does?" (alpha.10 §17).
 *
 * Two arms differing by exactly one thing: whether `Undo` is in the catalogue.
 * Everything else — fixture, prompt, profile, approvals, model — is identical.
 *
 * The interesting question is not "does undo work" (the regression matrix
 * answers that) but the one §17 names:
 *
 * > Undo is a tool with an unusually inviting description, and a model that
 * > undoes its way out of a difficulty instead of reading the error is a real
 * > failure mode worth measuring before it is anecdote.
 *
 * So two of the three tasks put a **difficulty** in the way — a stale receipt, a
 * refused edit — where the correct response is to re-read and the tempting one
 * is to reverse something. The third is an ordinary task with no difficulty at
 * all, and its purpose is the opposite: a model reaching for `Undo` there is
 * reaching for it because it is *there*, which is the alpha.7 finding
 * (adding a tool makes a different tool harder to call) in its clearest form.
 *
 * Three rules carried from the two experiments before this one:
 *
 *   **The control must be a model that cannot see the tool.** An arm that still
 *   had `Undo` and was told not to use it would measure wording.
 *
 *   **Each arm asserts its own premise**, from the catalogue the first step was
 *   frozen against. A `prepare` that silently failed compares an arm with itself
 *   and produces a beautifully clean null result.
 *
 *   **Both arms must be able to finish.** The withheld arm's scripted trajectory
 *   is the proof: every task here is solvable without `Undo`, by re-reading and
 *   editing again, which is also the behaviour undo is suspected of displacing.
 */

import type { FakeStep } from '../../src/model/adapters/fake.ts';
import type { Kernel } from '../../src/kernel.ts';
import type { GoldenTask } from '../tasks/golden.ts';
import { installReadInterference, type InterferenceLog, type InterferencePlan } from './interference.ts';

export type Arm = 'undo-available' | 'undo-withheld';

/** The tool alpha.10 added, and the one the control arm does not get. */
export const ALPHA10_UNDO_TOOLS = ['Undo'] as const;

export interface UndoUtilityTask extends GoldenTask {
  arm: Arm;
  baseId: string;
}

function assertCatalogue(kernel: Kernel, arm: Arm): void {
  const names = new Set(kernel.session.effectiveAllowedTools);
  for (const tool of ALPHA10_UNDO_TOOLS) {
    const present = names.has(tool);
    if (arm === 'undo-available' && !present) {
      throw new Error(`undo-utility: arm "${arm}" is missing ${tool}; the measurement would be meaningless`);
    }
    if (arm === 'undo-withheld' && present) {
      throw new Error(`undo-utility: arm "${arm}" still offers ${tool}; the control did not take effect`);
    }
  }
}

interface Base {
  id: string;
  description: string;
  files: Record<string, string>;
  prompt: string;
  livePrompt: string;
  /** How the task is solved. Identical in both arms; neither needs `Undo`. */
  script(receipt: (suffix: string) => string): FakeStep[];
  checks: GoldenTask['checks'];
  /**
   * A file that changes underneath the model, unprovoked (alpha.11 §10).
   *
   * Only the first task has one. It is the whole repair: alpha.10's version of
   * this task asked the *model* to run a script that rewrote the file, so a
   * competent model read afterwards and the difficulty never happened.
   */
  interference?: InterferencePlan;
}

const read = (path: string): FakeStep => ({
  kind: 'tools',
  calls: [{ name: 'Read', arguments: { path } }],
});

const edit = (path: string, oldString: string, newString: string, receiptId: string): FakeStep => ({
  kind: 'tools',
  calls: [{ name: 'Edit', arguments: { mode: 'replace', path, oldString, newString, receiptId } }],
});

const done = (text: string): FakeStep => ({ kind: 'final', text });

const fileEquals = (path: string, expected: string): GoldenTask['checks'][number] => ({
  name: `${path} has the expected content`,
  async run(ctx) {
    const actual = await ctx.read(path);
    return actual === expected
      ? undefined
      : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  },
});

const turnCompleted: GoldenTask['checks'][number] = {
  name: 'turn ends as completed',
  run(ctx) {
    const state = ctx.kernel.session.turn?.state;
    return state === 'completed' ? undefined : `turn ended as ${state}`;
  },
};

/**
 * The assertion alpha.10 §17 did not have, and the reason its result was empty.
 *
 * > A null result is still the answer; what is not acceptable is a null result
 * > from a fixture that could not have produced anything else.
 *
 * So the difficulty is asserted, per attempt, in both arms. If a run reports
 * "Undo was called 0 times" **and** this check passed, the zero means something.
 * If this check fails, the attempt says nothing about undo and must not be
 * counted as though it did.
 */
const difficultyOccurred = (read: () => InterferenceLog | undefined): GoldenTask['checks'][number] => ({
  name: 'the file actually changed underneath the model, and a call was refused for it',
  run() {
    const log = read();
    if (!log) return 'the interference seam was never installed';
    if (log.fired === 0) return 'the file was never changed underneath the model';
    if (!log.observedStaleRefusal) {
      return `the file changed ${log.fired}x but no call was refused as stale — the model never met the difficulty`;
    }
    return undefined;
  },
});

const BASES: Base[] = [
  {
    // A difficulty with a correct answer that is *not* undo. The file changes
    // under the model between its read and its edit, so the edit is refused for
    // a stale receipt. Re-reading fixes it; reversing anything does not.
    //
    // **Rebuilt in alpha.11.** The alpha.10 version handed the model a shell
    // script and asked it to run one, which meant the model chose when the file
    // changed — and both models chose to read afterwards, so no call was ever
    // refused and §17 measured nothing. Nothing in the prompt now mentions a
    // change at all: it is an ordinary edit that is refused for a reason the
    // model did not cause and cannot anticipate.
    id: 'recover-from-a-file-that-changed-underneath',
    description: 'A file changes between the read and the edit; the fix is to read again.',
    files: { 'src/config.ts': 'export const retries = 1;\n' },
    prompt: 'Set retries to 5.',
    livePrompt:
      'Set `retries` to 5 in src/config.ts. If a tool call is refused, read the error and act on ' +
      'what it says.',
    interference: {
      target: 'src/config.ts',
      becomes: (firing) => `export const retries = ${1 + firing};\n`,
    },
    script: (receipt) => [
      read('src/config.ts'),
      // Refused: the receipt describes bytes that are no longer there, because
      // the harness replaced them the instant the receipt was issued.
      edit('src/config.ts', 'export const retries = 1;', 'export const retries = 5;', receipt('config.ts')),
      read('src/config.ts'),
      edit('src/config.ts', 'export const retries = 2;', 'export const retries = 5;', receipt('config.ts')),
      done('The file had changed under me; I read it again and applied the edit.'),
    ],
    checks: [turnCompleted, fileEquals('src/config.ts', 'export const retries = 5;\n')],
  },

  {
    // A difficulty whose answer is to *finish*, not to reverse. The model has
    // already made a correct first edit when it meets a second file that needs
    // the same change; the failure mode is treating the first edit as the
    // problem.
    id: 'finish-a-two-file-rename',
    description: 'Two files need the same change; the first edit is correct.',
    files: {
      'src/a.ts': "import { helper } from './util-old.ts';\nexport const a = helper();\n",
      'src/b.ts': "import { helper } from './util-old.ts';\nexport const b = helper();\n",
      'src/util-old.ts': 'export const helper = () => 1;\n',
    },
    prompt: 'Update both imports to ./util.ts.',
    livePrompt:
      'The module src/util-old.ts is being renamed to src/util.ts. Update the import in both ' +
      'src/a.ts and src/b.ts to point at ./util.ts. Do not rename the file itself.',
    script: (receipt) => [
      read('src/a.ts'),
      edit('src/a.ts', './util-old.ts', './util.ts', receipt('a.ts')),
      read('src/b.ts'),
      edit('src/b.ts', './util-old.ts', './util.ts', receipt('b.ts')),
      done('Both imports now point at ./util.ts.'),
    ],
    checks: [
      turnCompleted,
      fileEquals('src/a.ts', "import { helper } from './util.ts';\nexport const a = helper();\n"),
      fileEquals('src/b.ts', "import { helper } from './util.ts';\nexport const b = helper();\n"),
    ],
  },

  {
    // No difficulty at all. Any `Undo` call here is the tool being reached for
    // because it exists.
    id: 'an-ordinary-single-file-fix',
    description: 'A one-line fix with nothing to recover from.',
    files: { 'src/math.ts': 'export const add = (a: number, b: number) => a - b;\n' },
    prompt: 'Fix add().',
    livePrompt: 'src/math.ts has a bug: add() subtracts. Fix it so it adds.',
    script: (receipt) => [
      read('src/math.ts'),
      edit('src/math.ts', 'a - b', 'a + b', receipt('math.ts')),
      done('add() now adds.'),
    ],
    checks: [
      turnCompleted,
      fileEquals('src/math.ts', 'export const add = (a: number, b: number) => a + b;\n'),
    ],
  },
];

export function undoUtilityTasks(): UndoUtilityTask[] {
  const out: UndoUtilityTask[] = [];

  for (const b of BASES) {
    for (const arm of ['undo-available', 'undo-withheld'] as const) {
      const withheld = arm === 'undo-withheld';
      // One log per task object, replaced on every `prepare` — which the runner
      // calls once per attempt — so a check reads the attempt it belongs to and
      // never the previous one's.
      let log: InterferenceLog | undefined;

      out.push({
        id: `${b.id}--${arm}`,
        baseId: b.id,
        arm,
        family: 'model-capability',
        // Bumped: the first task is a different task now, not a tuned one, and a
        // result from fixture 1 cannot be compared against a result from this.
        fixtureVersion: 2,
        description: b.description,
        files: b.files,
        prompt: b.prompt,
        livePrompt: b.livePrompt,
        script: b.script,
        checks: b.interference ? [...b.checks, difficultyOccurred(() => log)] : b.checks,
        approvals: [{ decision: 'allow', scope: 'session' }],
        prepare: (kernel: Kernel) => {
          if (withheld) {
            for (const tool of ALPHA10_UNDO_TOOLS) kernel.toolRegistry.unregister(tool);
          }
          assertCatalogue(kernel, arm);
          log = b.interference ? installReadInterference(kernel, b.interference) : undefined;
        },
      });
    }
  }

  return out;
}
