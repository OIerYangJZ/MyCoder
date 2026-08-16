/**
 * Fixtures for "does a foreign tool surface pay?" (alpha.9 §17).
 *
 * Three tasks, two arms. The arms differ by exactly one thing: whether a stdio
 * MCP server is attached and its tools are in the catalogue the model is shown.
 * Everything else — fixture, prompt, profile, approvals, model — is identical.
 *
 * The three design rules are carried over from the delegation and tool-utility
 * experiments, and all three were learned the hard way there:
 *
 *   **The control must be a model that cannot see the tools.** An arm that had
 *   them and was merely discouraged would measure wording. The absent arm
 *   attaches no server, so there is nothing to see.
 *
 *   **Each arm asserts its own premise.** A `prepare` that silently failed would
 *   compare an arm against itself and produce a beautifully clean null result.
 *
 *   **Zero is a real answer.** alpha.4 measured 0 of 25 delegations and the
 *   number was correct. If the model never calls a foreign tool, that is the
 *   finding, not a broken harness — which is why the premise assertion above is
 *   what distinguishes the two.
 *
 * The tasks are deliberately ones the **builtins already solve**. That is the
 * whole design: §17's question is not "can MCP do something new" but *"does a
 * foreign tool surface make the model better, worse, or merely busier"* — and
 * alpha.7 already found that adding a tool can make a **different** tool harder
 * to call. A task only solvable with the server would make the comparison
 * between a possible task and an impossible one, and any difference trivial.
 */

import * as path from 'node:path';

import type { Kernel } from '../../src/kernel.ts';
import type { GoldenTask } from '../tasks/golden.ts';
import { GOLDEN_TASKS } from '../tasks/golden.ts';
import { McpService } from '../../src/mcp/service.ts';
import { MCP_TOOL_PREFIX } from '../../src/mcp/naming.ts';

export type Arm = 'server-attached' | 'server-absent';

/** The fixture server, and the tools it offers. Named so the split is legible. */
export const FIXTURE_SERVER = 'notes';
export const FIXTURE_TOOLS = [`${MCP_TOOL_PREFIX}${FIXTURE_SERVER}__echo`] as const;

export interface McpUtilityTask extends GoldenTask {
  arm: Arm;
  baseId: string;
}

/**
 * Three golden tasks the builtins already solve.
 *
 * Ordinary work, chosen so the attached arm has a genuine choice to make: a
 * foreign `echo` tool is not useful for any of them, and a model that reaches
 * for it is telling us something about catalogue noise rather than about the
 * task.
 */
const BASE_IDS = ['single-file-bug-fix', 'test-driven-fix', 'multi-file-rename'] as const;

function base(id: string): GoldenTask {
  const task = GOLDEN_TASKS.find((t) => t.id === id);
  // Loud rather than skipped: a renamed golden task must not quietly shrink the
  // experiment to two cells, or to zero, while still reporting a clean result.
  if (!task) throw new Error(`mcp-utility: no golden task "${id}"`);
  return task;
}

/** Assert the arm really is the arm, from the catalogue the model was shown. */
function assertCatalogue(kernel: Kernel, arm: Arm): void {
  const names = new Set(kernel.session.effectiveAllowedTools);
  const foreign = [...names].filter((n) => n.startsWith(MCP_TOOL_PREFIX));

  if (arm === 'server-attached' && foreign.length === 0) {
    throw new Error(
      'mcp-utility: the "server-attached" arm has no foreign tools in its catalogue. The ' +
        'measurement would compare the control against itself.',
    );
  }
  if (arm === 'server-absent' && foreign.length > 0) {
    throw new Error(
      `mcp-utility: the "server-absent" arm still offers ${foreign.join(', ')}; the control did ` +
        'not take effect.',
    );
  }
}

/**
 * Every service this fixture started, so the experiment can close them.
 *
 * `GoldenTask` has no cleanup hook, and `runTask` builds a fresh kernel per
 * task — so a service attached in `prepare` outlives the kernel that used it.
 * The first run of this experiment hung forever with six orphaned server
 * processes holding the event loop open, which is the same "leaks the process"
 * hazard `McpService.start` tears down on a refusal. The experiment calls
 * `closeAttachedServers()` in a `finally`.
 */
const attached: McpService[] = [];

export async function closeAttachedServers(): Promise<void> {
  await Promise.all(attached.map((s) => s.close().catch(() => {})));
  attached.length = 0;
}

/**
 * Attach the fixture server to a live kernel.
 *
 * Through `McpService` and the real `ExecutionBackend`, not a stub: an
 * experiment that measured a fake surface would measure the fake.
 */
async function attachServer(kernel: Kernel): Promise<void> {
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'mcp-server.mjs');
  const service = await McpService.start({
    servers: {
      [FIXTURE_SERVER]: {
        transport: 'stdio',
        command: [process.execPath, fixture, '--mode=normal'],
      },
    },
    backend: kernel.backend.process,
    workspaceRoot: kernel.workspaceRoot,
  });

  attached.push(service);

  for (const definition of service.toolDefinitions()) {
    kernel.toolRegistry.register(definition);
  }
}

export function mcpUtilityTasks(): McpUtilityTask[] {
  const out: McpUtilityTask[] = [];

  for (const id of BASE_IDS) {
    const task = base(id);

    for (const arm of ['server-attached', 'server-absent'] as const) {
      out.push({
        ...task,
        id: `${id}--${arm}`,
        baseId: id,
        arm,
        approvals: [{ decision: 'allow', scope: 'session' }],
        prepare: async (kernel: Kernel) => {
          if (arm === 'server-attached') await attachServer(kernel);
          assertCatalogue(kernel, arm);
        },
      });
    }
  }

  return out;
}
