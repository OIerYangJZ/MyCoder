/**
 * Approval modes — who answers an `ask`.
 *
 * The policy engine decides `allow` / `ask` / `deny` / `hard_deny` from the
 * intersection of every layer. A mode does not touch that decision. It answers a
 * narrower question: when the answer is `ask`, does a human get asked?
 *
 * Keeping the two apart is the whole design, and it is worth being precise about
 * why. If a mode could turn a `deny` into an `allow`, it would be a capability —
 * and capabilities in this kernel only ever narrow (invariant 14). Because a mode
 * is instead an *answer* to a question the engine already decided to raise, the
 * strongest thing any mode can do is what the user could have done by pressing
 * `y`. `deny` and `hard_deny` never reach an approval at all: `ToolRuntime`
 * returns before it, so no mode can see them, let alone override them.
 *
 * Plan mode is the exception that proves the rule, and it goes the other way. It
 * cannot be expressed as "answer the questions differently", because the point is
 * that mutation must not be *reachable*, not that it be declined. So plan mode is
 * an extra policy layer — the builtin `read-only` profile — pushed onto the
 * engine. Because layers intersect, that is provably a narrowing, and the mode
 * gate below sees nothing at all in plan mode: the decisions arrive as `deny`
 * from the layer and never become approvals.
 *
 *     plan          read-only layer on the engine; the gate is not involved
 *     manual        every ask reaches the user (the default)
 *     accept-edits  workspace edits are taken as approved; everything else asks
 *     auto          edits, deletions and commands are taken as approved;
 *                   credentials, network, git history and MCP still ask
 *
 * `auto` stops where it does because of what the remaining four capabilities
 * *are*. `secret.use` injects a credential into a subprocess environment;
 * `network.connect` opens a channel to a named host; `vcs.mutate` rewrites
 * history that is somebody's record of what happened; `mcp.invoke` runs a tool
 * this kernel did not write and cannot inspect (ADR-0023 §1). None of those is
 * "an edit I would have approved anyway" — each is a decision whose consequence
 * leaves the workspace, and a mode that answered them would be a mode that
 * silently exports. Autonomy over the working tree is the thing worth automating;
 * autonomy over the boundary is not.
 */

import type { ApprovalOutcome, ApprovalPrompter, ApprovalRequest } from '../tools/runtime.ts';
import type { Capability } from './access.ts';
import { ALL_CAPABILITIES, capabilityOf } from './access.ts';

export type ApprovalMode = 'plan' | 'manual' | 'accept-edits' | 'auto';

/**
 * Cycle order, weakest autonomy first. Shift-Tab walks it and wraps.
 *
 * `plan` sits at the start rather than being excluded, because a cycle that
 * skipped it would need a second way to reach it and the two would drift. It is
 * also the only entry that is *more* restrictive than the default, so walking
 * forward from it is the natural direction of travel.
 */
export const APPROVAL_MODES: readonly ApprovalMode[] = ['plan', 'manual', 'accept-edits', 'auto'];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'manual';

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value);
}

export function cycleApprovalMode(current: ApprovalMode): ApprovalMode {
  const at = APPROVAL_MODES.indexOf(current);
  return APPROVAL_MODES[(at + 1) % APPROVAL_MODES.length] ?? DEFAULT_APPROVAL_MODE;
}

/**
 * Capabilities a mode answers on the user's behalf.
 *
 * A set per mode rather than a predicate with a `switch`, so the table can be
 * read as data and asserted against directly — the same reason
 * `WEAKENING_KEYS` is a table in `src/` and not a paragraph in `docs/`.
 *
 * `file.read` and `file.read_to_model` are absent from every set on purpose.
 * They are not missing coverage: a read that needs approval needs it because the
 * *path* is unusual — outside the workspace, or protected — and "read anything,
 * anywhere, without asking" is not what any of these modes is for. A protected
 * path is a hard deny and never reaches here regardless.
 */
const AUTO_ANSWERED: Readonly<Record<ApprovalMode, readonly Capability[]>> = {
  plan: [],
  manual: [],
  'accept-edits': ['file.write'],
  auto: ['file.write', 'file.delete', 'process.exec'],
};

/**
 * What this mode answers for you, in the order it is printed.
 *
 * The only accessor. There was briefly an `autoAnswers(mode, capability)`
 * predicate beside this — one letter away, different signature, the sort of pair
 * that gets called wrongly once and then reads as correct forever. Callers who
 * want the predicate write `autoAnswered(mode).includes(capability)`, which is
 * no longer to read and cannot be confused with anything.
 *
 * This is the list every user-facing surface reports, and the framing is the
 * fix for a defect the first version shipped: it printed the *complement* —
 * "still asks: file.write, file.delete, …" — computed as every capability the
 * mode does not answer.
 *
 * That number is a fact about the mode. The sentence built from it was a claim
 * about the whole policy stack, and in plan mode it was false: the read-only
 * layer denies writes, deletions, network, VCS, secrets and MCP outright, so
 * `/status` sat there reporting that a session which cannot write was about to
 * ask permission to write. Under a project `permissions.toml` with its own deny
 * rules the same sentence is wrong in `manual` too.
 *
 * So nothing derives an "asks" list any more. What a mode answers is knowable
 * here; what is asked is only knowable by asking the engine, and neither
 * `/mode` nor `/status` is going to guess at it.
 */
export function autoAnswered(mode: ApprovalMode): readonly Capability[] {
  return AUTO_ANSWERED[mode];
}

/**
 * Capabilities no mode answers, whatever the mode — recorded, not printed.
 *
 * The two reads, because a read that needs approval needs it for the *path* —
 * outside the workspace, or protected — and no mode here is "read anything,
 * anywhere". `env.read` because it is a system hard deny: it can never be an
 * approval, so listing it as one a mode might answer would be false.
 *
 * Asserted against `AUTO_ANSWERED` by the unit suite rather than used to derive
 * anything, which is what is left of it once the complement is not computed.
 */
export const NEVER_ANSWERED: readonly Capability[] = ALL_CAPABILITIES.filter(
  (c) => c === 'file.read' || c === 'file.read_to_model' || c === 'env.read',
);

export interface ApprovalModeDescription {
  mode: ApprovalMode;
  /** Two or three words, for a status line. */
  label: string;
  /** One sentence, in the words a disclosure would use. */
  summary: string;
}

/** What each mode is called on a status line. */
const MODE_LABELS: Readonly<Record<ApprovalMode, string>> = {
  plan: 'plan',
  manual: 'manual',
  'accept-edits': 'accept edits',
  auto: 'auto',
};

/**
 * Summaries for the two modes that answer nothing, and only those two.
 *
 * A partial record on purpose. The other two summaries are generated from
 * `autoAnswered`, and an earlier version carried them here as empty strings —
 * dead fields in a table, read only by the branch that never wanted them. A
 * `Partial` says which modes have hand-written prose; two empty strings said
 * nothing and invited somebody to fill them in with a copy of the list.
 *
 * Only plan states a disposition, and it is entitled to: its read-only layer is
 * a fact about the mode, not a guess about the stack. Manual's is the definition
 * of the default. Neither predicts what any other layer will do.
 *
 * Plan's wording is careful for a reason. It first said "nothing can be changed
 * even by approving it", which was **false**, and was caught by running it on a
 * real machine rather than by any test here. Under `read-only`, `process.exec`
 * for a development executable is `ask` — Appendix A says so deliberately, so
 * that a review session can still run the test suite — and `bash` is on that
 * list. Approving one shell command in plan mode therefore writes whatever the
 * command writes, which the probe confirmed by doing it.
 *
 * So the sentence now says what is actually denied (the mutating *tools*, which
 * no approval can reach) and what is not (a command, which is still asked and is
 * a subprocess policy cannot follow once it runs).
 */
const NO_GRANT_PROSE: Readonly<Partial<Record<ApprovalMode, string>>> = {
  plan:
    'Read and analyse. A read-only layer denies the mutating tools outright — writes, deletions, ' +
    'network, VCS and MCP — and no approval can reach them. Running a development command is ' +
    'still asked, and an approved command is a subprocess the policy engine cannot follow.',
  manual: 'Every approval the policy engine raises is put to you.',
};

export function describeApprovalMode(mode: ApprovalMode): ApprovalModeDescription {
  const label = MODE_LABELS[mode];
  const answered = autoAnswered(mode);
  if (answered.length === 0) {
    return { mode, label, summary: NO_GRANT_PROSE[mode] ?? 'This mode answers nothing on your behalf.' };
  }

  return {
    mode,
    label,
    summary:
      `Applies without asking: ${answered.join(', ')}. ` +
      'Everything else is put to you, unless a policy layer denies it first.',
  };
}

/**
 * Is this mode weaker than the default, and therefore owed a disclosure (§12)?
 *
 * `accept-edits` counts. It is a small step — an edit is reversible, journalled
 * and visible as a diff — but it is still a decision the user is no longer making
 * per action, and §12's test is whether a boundary moved, not whether the move
 * was comfortable.
 */
export function weakensApproval(mode: ApprovalMode): boolean {
  return mode === 'accept-edits' || mode === 'auto';
}

/**
 * The current mode, in one place both the gate and the session can reach.
 *
 * A holder rather than a field on either, because of construction order: the
 * prompter is built before the tool runtime, which is built before the session,
 * and the session is what owns changing the mode. Passing a getter down and a
 * setter back up would put the value in two places and make "which one is
 * authoritative" a question — the same shape of bug as a `/status` that reads the
 * backend's view while the model is told the session's.
 *
 * Not persisted. A mode is session state: it is what the user has decided to be
 * asked about *right now*, and it dies with the process. The starting value comes
 * from `[security] approval_mode`; a Shift-Tab does not write to it, because a
 * keystroke that silently edited a security setting on disk would be the kind of
 * durable consequence a keystroke should not have.
 *
 * **Which means `mycoder -c` does not resume the mode, while it does resume the
 * model.** That asymmetry is deliberate and it only ever goes one way: a session
 * resumed after a Shift-Tab into `auto` comes back in whatever the config says,
 * which is `manual` unless the user wrote otherwise. Restoring `auto` from a
 * previous process would re-weaken the session without a fresh disclosure, on the
 * strength of a keystroke pressed before a restart — and §12 asks for the
 * disclosure at startup precisely so that state like this cannot arrive quietly.
 */
export class ApprovalModeState {
  private current: ApprovalMode;
  private readonly onChange: ((mode: ApprovalMode, previous: ApprovalMode) => void) | undefined;

  constructor(
    initial: ApprovalMode = DEFAULT_APPROVAL_MODE,
    onChange?: (mode: ApprovalMode, previous: ApprovalMode) => void,
  ) {
    this.current = initial;
    this.onChange = onChange;
  }

  get mode(): ApprovalMode {
    return this.current;
  }

  set(mode: ApprovalMode): { changed: boolean; previous: ApprovalMode } {
    const previous = this.current;
    if (previous === mode) return { changed: false, previous };
    this.current = mode;
    this.onChange?.(mode, previous);
    return { changed: true, previous };
  }

  cycle(): { mode: ApprovalMode; previous: ApprovalMode } {
    const previous = this.current;
    const next = cycleApprovalMode(previous);
    this.set(next);
    return { mode: next, previous };
  }
}

export interface ModeGateEvent {
  mode: ApprovalMode;
  capability: Capability;
  subjectKey: string;
  summary: string;
}

/**
 * The gate: an `ApprovalPrompter` that answers what its mode covers and delegates
 * the rest.
 *
 * A wrapper rather than a branch inside `ToolRuntime`, because the runtime
 * already has exactly one place where a human is consulted and adding a second
 * path to the same question is how the two get different answers. This composes
 * instead: in a non-interactive session the delegate is the `DenyingPrompter`, so
 * `auto` grants what it covers and everything else is refused — which is the
 * correct reading of "nobody is here to ask" and needed no special case.
 *
 * Deliberately does **not** record anything in `SessionApprovalStore`. That store
 * is what `/permissions show` prints and what `/permissions explain` answers from,
 * and it means "the user decided this". A mode-answered action was never put to
 * the user, so writing it there would put words in their mouth.
 */
export class ModeGatedPrompter implements ApprovalPrompter {
  private readonly delegate: ApprovalPrompter;
  private readonly mode: () => ApprovalMode;
  private readonly onAutoAnswer: ((event: ModeGateEvent) => void) | undefined;

  constructor(opts: {
    delegate: ApprovalPrompter;
    /** Read live: the mode can change between tool calls. */
    mode: () => ApprovalMode;
    /** Called for each action the mode answered, so it can be logged and shown. */
    onAutoAnswer?: (event: ModeGateEvent) => void;
  }) {
    this.delegate = opts.delegate;
    this.mode = opts.mode;
    this.onAutoAnswer = opts.onAutoAnswer;
  }

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const mode = this.mode();
    const capabilities = request.pending.map((d) => capabilityOf(d.access));

    // Every capability, not any: a tool call that wants to write a file *and*
    // reach a host is one approval covering both, and a mode that answered it
    // because of the write would have granted the host silently. This is the
    // same rule `PolicyEngine.combine` applies to the decisions themselves —
    // a tool runs only if everything it declared is permitted.
    const answered = autoAnswered(mode);
    const covered = capabilities.length > 0 && capabilities.every((c) => answered.includes(c));

    if (!covered) return this.delegate.request(request);

    this.onAutoAnswer?.({
      mode,
      capability: capabilities[0]!,
      subjectKey: request.subject.key,
      summary: request.subject.title,
    });
    // `once`, never `session`: the grant is the mode's, and it lasts exactly as
    // long as the mode does. Recording it for the session would outlive a
    // Shift-Tab back to manual and turn a mode into a set of approvals.
    //
    // `answeredByMode` is what keeps the durable log honest. Without it
    // `approval.decided` records this in the same bytes as a user pressing `y`,
    // and "which of these did a human review" becomes unanswerable for a session
    // that ran in `auto` — which is the first question anybody would ask of one.
    return { decision: 'allow', scope: 'once', answeredByMode: true };
  }
}
