/**
 * Fixtures for the delegation-utility experiment (alpha.4 §36's open question).
 *
 * alpha.4 measured that DeepSeek chose to delegate **0 times out of 10** on tasks
 * where subagents were available and the choice was left to it — and solved them
 * all anyway. That leaves three explanations with very different consequences:
 *
 *   1. the tasks were too small for delegation to pay;
 *   2. the `Delegate` tool is described in a way that suppresses its use;
 *   3. delegation genuinely does not help this model.
 *
 * The first two are addressed here. Phase 1 varies *task size* with the shipped
 * tool description; phase 2 holds the largest task fixed and varies the
 * **description**, because if the answer is still "never" at eighteen files and two
 * independent faults, the sentence telling the model not to bother is the next
 * suspect. Three sizes, each in two conditions: agents discoverable, and agents
 * absent. The second condition is a real control rather than a formality — with no
 * agent definitions the kernel does not register the `Delegate` tool at all
 * (ADR-0013), so the model cannot be influenced by a tool it never sees.
 *
 * Two rules the prompts follow, both from §34:
 *
 *   - **Nothing mentions delegation.** "Use a subagent now" measures
 *     instruction-following. The question here is whether a model reaches for the
 *     tool unprompted, so the prompt must read like a user's.
 *   - **The checks are about outcomes**, not trajectories: which root cause was
 *     named, what the file contains afterwards. A check that asserted "it
 *     delegated" would answer the question by assuming it.
 *
 * The largest fixture deliberately contains **two independent** faults in two
 * subsystems. That is the canonical shape delegation should help with even when it
 * is sequential: two self-contained investigations, neither needing the other's
 * context. If delegation does not pay here, "the task was too small" stops being
 * an available explanation.
 */

import type { GoldenTask, GoldenTaskCheck } from '../tasks/golden.ts';
import type { Kernel } from '../../src/kernel.ts';
import { createDelegateTool } from '../../src/tools/builtin/delegate.ts';

/** A read-only investigator, described as helpfully as I know how to. */
const INVESTIGATOR = [
  '---',
  'name: investigator',
  'description: >-',
  '  Investigates one self-contained question in a codebase and reports the root cause with',
  '  file and line. Read-only: it cannot edit, so it is safe to point at anything.',
  'permission_profile: read-only',
  'tools: [Read, Grep, Glob]',
  '---',
  '',
  'You investigate exactly the question you were given, and nothing else.',
  '',
  'Work by searching before reading: use Grep to find the relevant symbols, then Read the',
  'specific regions that matter. Follow the data as far as it goes across files.',
  '',
  'Report back in a few lines: the root cause, the file and line it lives in, and how the',
  'symptom follows from it. If you could not determine it, say what you ruled out. You',
  'cannot modify anything, so do not propose an edit — describe the cause.',
  '',
].join('\n');

function check(name: string, run: GoldenTaskCheck['run']): GoldenTaskCheck {
  return { name, run };
}

const answerMentions = (label: string, pattern: RegExp): GoldenTaskCheck =>
  check(`the answer identifies ${label}`, (ctx) => {
    const text = ctx.kernel.session.turn?.finalText ?? '';
    return pattern.test(text) ? undefined : `not named in the answer: ${text.slice(0, 200)}`;
  });

const nothingLeftOpen: GoldenTaskCheck = check('every tool call has a result', (ctx) =>
  ctx.kernel.context.openToolCalls().length === 0 ? undefined : 'a tool call was left unanswered',
);

const nothingEdited: GoldenTaskCheck = check('a diagnosis changed nothing', (ctx) => {
  const dirty = ctx.kernel.session.editJournal.dirtyPaths();
  return dirty.length === 0 ? undefined : `it edited ${dirty.join(', ')}`;
});

/**
 * NEGATIVE CONTROL: the model was actually offered the tool.
 *
 * Without this, "it never delegated" is indistinguishable from "the harness never
 * registered `Delegate`" — and the second would be my bug reported as a finding
 * about the model. The catalogue checked here is the one `freezeStep` builds when
 * no skill has narrowed it, which is the case in every cell of this experiment.
 */
const delegateWasOffered: GoldenTaskCheck = check(
  'NEGATIVE CONTROL: Delegate was in the catalogue',
  (ctx) => {
    if (!ctx.kernel.delegation) return 'no delegation service was built, so no agent was discovered';
    const offered = ctx.kernel.toolRegistry.view({}).tools.map((t) => t.name);
    return offered.includes('Delegate') ? undefined : `the catalogue the model saw was ${offered.join(', ')}`;
  },
);

// --- small: one file, one line. Delegation should NOT pay here ---------------

const SMALL_FILES: Record<string, string> = {
  'src/clamp.ts':
    'export function clamp(value: number, min: number, max: number) {\n' +
    '  if (value < min) return max;\n' +
    '  if (value > max) return min;\n' +
    '  return value;\n' +
    '}\n',
};

const SMALL_FIXED =
  'export function clamp(value: number, min: number, max: number) {\n' +
  '  if (value < min) return min;\n' +
  '  if (value > max) return max;\n' +
  '  return value;\n' +
  '}\n';

// --- medium: six files, one root cause three of them deep -------------------

const MEDIUM_FILES: Record<string, string> = {
  'src/parse.ts':
    '/** Parse a user-supplied age. */\n' +
    'export function parseAge(input: string): number {\n' +
    '  return Number.parseInt(input);\n' +
    '}\n',
  'src/report.ts':
    "import { parseAge } from './parse.ts';\n" +
    '\n' +
    'export function report(input: string): string {\n' +
    '  const age = parseAge(input);\n' +
    '  return `age is ${age.toFixed(0)}`;\n' +
    '}\n',
  'src/index.ts':
    "import { report } from './report.ts';\n" +
    '\n' +
    'export const main = (raw: string) => report(raw.trim());\n',
  'src/format.ts':
    'export const currency = (n: number) => `$${n.toFixed(2)}`;\n' +
    'export const percent = (n: number) => `${Math.round(n * 100)}%`;\n',
  'src/validate.ts':
    'export const isPresent = (s: string | undefined): s is string => s !== undefined && s !== "";\n' +
    'export const isEmail = (s: string) => /.+@.+\\..+/.test(s);\n',
  'README.md':
    '# report\n\n`report(input)` renders a human-readable age from a form field.\n\n' +
    'The form field is free text, because the upstream provider sends things like `42`, ` 42 `\n' +
    'and occasionally `42 years`.\n',
};

// --- large: eighteen files, two independent faults --------------------------

const LARGE_FILES: Record<string, string> = {
  'README.md':
    '# orders\n\nA small order service: auth, billing and orders.\n\n' +
    '- `src/auth` — sessions and tokens\n' +
    '- `src/billing` — tax, discounts, invoices\n' +
    '- `src/orders` — order lifecycle\n' +
    '- `src/api` — HTTP surface\n',
  'package.json': '{\n  "name": "orders",\n  "private": true,\n  "type": "module"\n}\n',

  // --- auth: fault A lives here ---
  'src/auth/session.ts':
    "import type { Session } from './types.ts';\n" +
    '\n' +
    '/** True when the session may no longer be used. */\n' +
    'export function isExpired(session: Session, now: number): boolean {\n' +
    '  return now < session.expiresAt;\n' +
    '}\n' +
    '\n' +
    'export function touch(session: Session, now: number): Session {\n' +
    '  return { ...session, lastSeenAt: now };\n' +
    '}\n',
  'src/auth/types.ts':
    'export interface Session {\n' +
    '  id: string;\n' +
    '  userId: string;\n' +
    '  createdAt: number;\n' +
    '  expiresAt: number;\n' +
    '  lastSeenAt: number;\n' +
    '}\n',
  'src/auth/token.ts':
    'export const sign = (userId: string, nonce: string) => `${userId}.${nonce}`;\n' +
    "export const parse = (token: string) => token.split('.')[0] ?? '';\n",
  'src/auth/middleware.ts':
    "import { isExpired } from './session.ts';\n" +
    "import { load } from './store.ts';\n" +
    '\n' +
    'export async function requireSession(id: string, now: number) {\n' +
    '  const session = await load(id);\n' +
    "  if (!session) throw new Error('no session');\n" +
    "  if (isExpired(session, now)) throw new Error('session expired');\n" +
    '  return session;\n' +
    '}\n',
  'src/auth/store.ts':
    "import type { Session } from './types.ts';\n" +
    '\n' +
    'const sessions = new Map<string, Session>();\n' +
    'export const save = async (s: Session) => void sessions.set(s.id, s);\n' +
    'export const load = async (id: string) => sessions.get(id);\n',

  // --- billing: fault B lives here ---
  'src/billing/invoice.ts':
    "import { applyTax } from './tax.ts';\n" +
    "import { applyDiscount } from './discount.ts';\n" +
    '\n' +
    '/** Total for a line-item subtotal, a coupon and a tax region. */\n' +
    'export function invoiceTotal(subtotal: number, coupon: number, region: string): number {\n' +
    '  const taxed = applyTax(subtotal, region);\n' +
    '  return applyDiscount(taxed, coupon);\n' +
    '}\n',
  'src/billing/tax.ts':
    'const RATES: Record<string, number> = { uk: 0.2, de: 0.19, us: 0.0 };\n' +
    '\n' +
    'export function applyTax(amount: number, region: string): number {\n' +
    '  const rate = RATES[region] ?? 0;\n' +
    '  return amount * (1 + rate);\n' +
    '}\n',
  'src/billing/discount.ts':
    '/** `coupon` is an absolute amount in the order currency, not a fraction. */\n' +
    'export function applyDiscount(amount: number, coupon: number): number {\n' +
    '  return Math.max(0, amount - coupon);\n' +
    '}\n',
  'src/billing/money.ts':
    'export const cents = (n: number) => Math.round(n * 100);\n' +
    'export const fromCents = (n: number) => n / 100;\n',

  // --- orders and api: neither fault is here ---
  'src/orders/create.ts':
    "import { invoiceTotal } from '../billing/invoice.ts';\n" +
    '\n' +
    'export function createOrder(subtotal: number, coupon: number, region: string) {\n' +
    "  return { status: 'created', total: invoiceTotal(subtotal, coupon, region) };\n" +
    '}\n',
  'src/orders/list.ts': 'export const listOrders = async (userId: string) => [] as unknown[];\n',
  'src/orders/status.ts':
    "export type OrderStatus = 'created' | 'paid' | 'shipped' | 'cancelled';\n" +
    "export const isFinal = (s: OrderStatus) => s === 'shipped' || s === 'cancelled';\n",
  'src/api/routes.ts': "export const routes = ['POST /orders', 'GET /orders', 'POST /login'] as const;\n",
  'src/api/handlers.ts':
    "import { requireSession } from '../auth/middleware.ts';\n" +
    "import { createOrder } from '../orders/create.ts';\n" +
    '\n' +
    'export async function postOrder(sessionId: string, body: { subtotal: number; coupon: number; region: string }) {\n' +
    '  await requireSession(sessionId, Date.now());\n' +
    '  return createOrder(body.subtotal, body.coupon, body.region);\n' +
    '}\n',
  'src/util/clock.ts': 'export const now = () => Date.now();\n',
  'src/util/log.ts': 'export const log = (...args: unknown[]) => void args;\n',
  'tests/billing.test.ts':
    "import { invoiceTotal } from '../src/billing/invoice.ts';\n" +
    '\n' +
    '// 100.00 subtotal, a 10.00 coupon, UK VAT. Finance says this should print 108.\n' +
    "console.log(invoiceTotal(100, 10, 'uk'));\n",
  'tests/auth.test.ts':
    "import { isExpired } from '../src/auth/session.ts';\n" +
    '\n' +
    '// A session that expires an hour from now is not expired.\n' +
    "console.log(isExpired({ id: 's', userId: 'u', createdAt: 0, expiresAt: Date.now() + 3_600_000, lastSeenAt: 0 }, Date.now()));\n",
};

export type Condition = 'agents-available' | 'no-agents';
export type Size = 'small' | 'medium' | 'large';

interface SizeSpec {
  size: Size;
  files: Record<string, string>;
  livePrompt: string;
  checks: GoldenTaskCheck[];
  /** What the size is meant to establish. Printed in the report. */
  intent: string;
}

const SIZES: SizeSpec[] = [
  {
    size: 'small',
    intent: 'one file, one line — delegation should not pay, and choosing it would be waste',
    files: SMALL_FILES,
    livePrompt:
      'clamp() in src/clamp.ts returns the wrong bound at each end: a value below the minimum ' +
      'comes back as the maximum and vice versa. Fix it so each end returns its own bound.',
    checks: [
      check('src/clamp.ts is fixed', async (ctx) => {
        const actual = await ctx.read('src/clamp.ts');
        return actual === SMALL_FIXED ? undefined : `contents are:\n${actual}`;
      }),
      nothingLeftOpen,
    ],
  },
  {
    size: 'medium',
    intent: 'six files, one root cause three files deep — delegation is marginal',
    files: MEDIUM_FILES,
    livePrompt:
      'report() sometimes returns "age is NaN" instead of a number, for input that comes from a ' +
      'free-text form field. Work out the root cause and tell me which file and line it is in. ' +
      'Do not change anything yet.',
    checks: [
      answerMentions('the parsing step', /parse|parseInt|radix|trailing|NaN/i),
      answerMentions('the file it lives in', /parse\.ts/i),
      nothingEdited,
      nothingLeftOpen,
    ],
  },
  {
    size: 'large',
    intent:
      'eighteen files, two independent faults in two subsystems — the shape delegation should help with',
    files: LARGE_FILES,
    livePrompt:
      'Two bug reports came in against this service.\n\n' +
      '1. Users are signed out immediately after logging in, even though their session is supposed ' +
      'to last an hour.\n' +
      '2. A 100.00 order with a 10.00 coupon in the UK is charged 110.00. Finance says it should be ' +
      '108.00, and the gap grows with the size of the coupon.\n\n' +
      'Find the root cause of each and tell me the file and line for both. Do not change anything ' +
      'yet — I want to review the diagnosis first.',
    checks: [
      answerMentions('the session fault', /isExpired|session\.ts/i),
      answerMentions('the billing fault', /invoice\.ts|discount|tax/i),
      check('the answer covers both faults, not just one', (ctx) => {
        const text = ctx.kernel.session.turn?.finalText ?? '';
        const auth = /isExpired|session\.ts|expir/i.test(text);
        const billing = /invoice\.ts|discount|tax/i.test(text);
        return auth && billing ? undefined : `auth=${auth} billing=${billing}`;
      }),
      nothingEdited,
      nothingLeftOpen,
    ],
  },
];

/**
 * The six tasks: three sizes × two conditions.
 *
 * The two conditions differ by exactly one thing — whether an agent definition
 * exists in the workspace — so any difference in the numbers is attributable to
 * that. `fixtureVersion` is shared, because the prompt and the acceptance criteria
 * are shared; it is the *workspace* that varies, and the task id records which.
 */
export function delegationUtilityTasks(): Array<
  GoldenTask & { condition: Condition; size: Size; intent: string }
> {
  const tasks: Array<GoldenTask & { condition: Condition; size: Size; intent: string }> = [];

  for (const spec of SIZES) {
    for (const condition of ['agents-available', 'no-agents'] as const) {
      tasks.push({
        id: `delegation-utility-${spec.size}-${condition}`,
        family: 'model-capability',
        fixtureVersion: 1,
        description: `${spec.intent} (${condition})`,
        condition,
        size: spec.size,
        intent: spec.intent,
        files: {
          ...spec.files,
          ...(condition === 'agents-available' ? { '.mycoder/agents/investigator.md': INVESTIGATOR } : {}),
        },
        // Live-only: the whole question is what a real model chooses. A scripted
        // run would be answering it on the model's behalf.
        prompt: spec.livePrompt,
        livePrompt: spec.livePrompt,
        script: () => [],
        checks: condition === 'agents-available' ? [...spec.checks, delegateWasOffered] : spec.checks,
      });
    }
  }

  return tasks;
}

// --- phase 2: the same task, a different description -------------------------

/**
 * The shipped `Delegate` description ends with a sentence that reads, to a model
 * that can do everything itself, as "never":
 *
 *   > Use it when a task is genuinely separable … and **not for work you can do
 *   > directly in a step or two**: a delegation costs a whole model conversation.
 *
 * That clause exists for a good reason — an eager delegator burns a whole
 * conversation on a one-line edit — but it may be the whole explanation for 0/15.
 * This variant keeps the cost statement and drops the prohibition, and names the
 * two situations where delegation is supposed to pay instead of the one where it
 * does not.
 *
 * If this moves the number, the finding is about the *product's wording* and the
 * fix is a one-line change. If it does not, the wording is exonerated and the
 * remaining explanation is about the model.
 */
export const NEUTRAL_DELEGATE_DESCRIPTION =
  'Hand a self-contained sub-question to a specialist subagent and wait for its report. ' +
  'The child has its own context and its own budget and sees none of this conversation, so the task ' +
  'must stand alone. Two situations it is meant for: several independent investigations that would ' +
  'otherwise all have to fit in your own context, and a focused review by an agent with narrower ' +
  'permissions than yours. A delegation costs a separate model conversation, and the report comes ' +
  "back to you as this call's result.";

export type DescriptionVariant = 'shipped' | 'neutral';

/**
 * The large task, twice: once with the shipped description, once with the variant.
 *
 * The override goes through `ToolRegistry.override`, which exists for exactly this
 * ("replace a registration") — so the product keeps no experiment knob, and what
 * varies is a string in the catalogue the first step is frozen against.
 */
export function descriptionVariantTasks(): Array<
  GoldenTask & { variant: DescriptionVariant; size: Size; intent: string }
> {
  const large = delegationUtilityTasks().find(
    (t) => t.size === 'large' && t.condition === 'agents-available',
  )!;

  return (['shipped', 'neutral'] as const).map((variant) => ({
    ...large,
    id: `delegation-description-${variant}`,
    variant,
    intent: `eighteen files, two faults, ${variant} Delegate description`,
    // The description the model was actually offered is asserted, not assumed. A
    // `prepare` hook that silently failed would make phase 2 a comparison of the
    // shipped description against itself — and would produce exactly the result
    // that is interesting, for the wrong reason.
    checks: [
      ...large.checks,
      {
        name: `NEGATIVE CONTROL: the ${variant} description reached the catalogue`,
        run: (ctx) => {
          const offered = ctx.kernel.toolRegistry.view({}).tools.find((t) => t.name === 'Delegate');
          if (!offered) return 'Delegate was not in the catalogue at all';
          const isNeutral = offered.description === NEUTRAL_DELEGATE_DESCRIPTION;
          if (variant === 'neutral' && !isNeutral) return 'the override did not take effect';
          if (variant === 'shipped' && isNeutral) return 'the shipped run used the variant description';
          return undefined;
        },
      },
    ],
    ...(variant === 'neutral'
      ? {
          prepare: (kernel: Kernel) => {
            const base = createDelegateTool({ agents: kernel.agents.map((a) => a.name) });
            kernel.toolRegistry.override({ ...base, description: NEUTRAL_DELEGATE_DESCRIPTION });
          },
        }
      : {}),
  }));
}
