/**
 * A harness seam that produces the difficulty the §17 experiment measures.
 *
 * alpha.10 §17 asked whether a model reaches for `Undo` instead of reading the
 * error it was handed. Two of its three tasks were built to put a model in
 * difficulty and **neither did**: the workspace was changed by a shell command
 * *the model scheduled*, so both models simply read afterwards, no call was ever
 * rejected, and the result was a null that measured nothing.
 *
 * The flaw is specific. For the difficulty to be a difficulty it has to arrive
 * **between the model's read and its edit**, and the model must not have caused
 * it. So:
 *
 * ```text
 * Read executes → receipt issued → THIS mutates the file → Edit refused STALE_FILE
 * ```
 *
 * ## Why it disarms itself
 *
 * The trap fires on **every** read of the target until a stale refusal has
 * actually been observed, and then never again. Both halves matter:
 *
 *   - firing once would be defeated by a model that reads twice before editing,
 *     and would produce exactly the null result this exists to prevent;
 *   - firing forever would make the task unsolvable, which breaks the rule
 *     carried from every experiment before this one — **both arms must be able
 *     to finish**, because a task no model can complete measures the task.
 *
 * Each firing writes *different* bytes, for a reason that took a rewrite to
 * notice: writing the same replacement twice leaves the second read's hash
 * matching the file, and the trap silently stops being a trap.
 *
 * ## What this is not
 *
 * It is not a product capability and there is no route to it from a session. It
 * is a decorator the *harness* wraps around a tool definition after
 * `createKernel` has returned, using `ToolRegistry.override`, in a directory
 * that is not in the package's `files` list. `tests/evals/interference.test.ts`
 * asserts both of those rather than trusting this paragraph.
 */

import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { Kernel } from '../../src/kernel.ts';
import type { ToolDefinition, ToolExecution, ToolResolveContext } from '../../src/tools/contract.ts';

/** Tools whose refusal proves the difficulty landed, so the trap can stand down. */
const MUTATORS = ['Edit', 'Write', 'Delete', 'Move'] as const;

export interface InterferencePlan {
  /** Workspace-relative file whose read arms the trap. */
  target: string;
  /**
   * The file's new contents, given how many times the trap has fired.
   *
   * A function rather than a string so that consecutive firings differ; see the
   * header for what happens when they do not.
   */
  becomes(firing: number): string;
}

export interface InterferenceLog {
  /** How many times the file was changed underneath the model. */
  fired: number;
  /** Whether a mutating call was actually refused as stale. */
  observedStaleRefusal: boolean;
}

/**
 * Wrap `Read` so a file changes underneath the model, once, unprovoked.
 *
 * Returns the log, which is what a check asserts against: a fixture that could
 * not have produced its own condition is the defect being fixed, so "the trap
 * fired and something was refused for it" has to be an assertion rather than an
 * assumption.
 */
export function installReadInterference(kernel: Kernel, plan: InterferencePlan): InterferenceLog {
  const log: InterferenceLog = { fired: 0, observedStaleRefusal: false };
  const absolute = path.join(kernel.workspaceRoot, plan.target);

  const readTool = kernel.toolRegistry.get('Read');
  if (!readTool) {
    throw new Error('interference: Read is not registered, so there is no receipt to invalidate');
  }

  kernel.toolRegistry.override<never>({
    ...readTool,
    async resolve(args: never, ctx: ToolResolveContext): Promise<ToolExecution> {
      const execution = await readTool.resolve(args, ctx);
      const requested = (args as unknown as { path?: unknown }).path;

      return {
        ...execution,
        async execute(executor, signal) {
          const result = await execution.execute(executor, signal);

          // After the receipt exists and before the next call is resolved. A
          // failed read is left alone: there is no receipt to invalidate, and
          // rewriting the file would change what the *next* attempt reads.
          const armed = !log.observedStaleRefusal && !result.isError;
          if (armed && typeof requested === 'string' && requested.endsWith(plan.target)) {
            log.fired += 1;
            await writeFile(absolute, plan.becomes(log.fired), 'utf8');
          }
          return result;
        },
      };
    },
  });

  for (const name of MUTATORS) {
    const tool = kernel.toolRegistry.get(name);
    if (!tool) continue;

    kernel.toolRegistry.override<never>({
      ...tool,
      async resolve(args: never, ctx: ToolResolveContext): Promise<ToolExecution> {
        const execution = await tool.resolve(args, ctx);
        return {
          ...execution,
          async execute(executor, signal) {
            const result = await execution.execute(executor, signal);
            if (result.errorCode === 'STALE_FILE') log.observedStaleRefusal = true;
            return result;
          },
        };
      },
    });
  }

  return log;
}

/**
 * The refusal a resolve-time check produces, which never reaches `execute`.
 *
 * `Edit` decides staleness in `resolve()` — before any effect — so the refusal
 * is a `refusedExecution` whose result the wrapper above does see, because the
 * wrapper decorates the execution rather than the resolve. Kept as a named
 * export so a test can assert the code it is watching for is the code the kernel
 * actually emits, rather than a string that was right when it was written.
 */
export const STALE_REFUSAL_CODE = 'STALE_FILE';

/** Every tool this seam decorates, for the test that asserts it is harness-only. */
export const INTERFERED_TOOLS: readonly string[] = ['Read', ...MUTATORS];

export type { ToolDefinition };
