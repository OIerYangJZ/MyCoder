# ADR-0013 — Delegated execution runtime

**Status:** accepted (`v0.1.0-alpha.4`)
**Supersedes:** nothing. Extends ADR-0004 (capability intersection) and ADR-0008
(append-only event log).
**Numbering note:** the alpha.4 plan §6 suggested "ADR-0011". That number was
taken by the persistent credential source in alpha.3, so this is ADR-0013.

## Context

Through alpha.3, subagents and skills were configuration-only surfaces.
`deriveSubagent()` computed a capability set, `discoverAgents()` and
`discoverSkills()` parsed definitions, `/status` listed them — and nothing had
ever run. No child had sampled a model, executed a tool, been denied by policy,
been cancelled, or appeared in the event log.

alpha.3 turned three checklist areas into executable gates and found ten defects
that all previous testing had missed, two of which meant a shipped subsystem
could not connect at all. The rule that came out of it is written into the alpha.4
plan:

> A layer that has never crossed the real runtime path is unvalidated, regardless
> of how good its pure-function tests look.

Delegation is the largest such layer left. It also touches every security
boundary at once: capability, budget, secrets, context, cancellation, hooks,
replay. That combination is what makes it worth an ADR rather than a feature
commit — three public interfaces change, and one of them is the `AccessRequest`
union, which AGENTS.md rule 4 and the plan §11 both require an ADR to touch.

## Decision

### 1. A child is a `Session`, not a second loop

`DelegationService` constructs a child _scope_ out of the components that already
exist:

```
Parent Runtime
    ↓
DelegationService
    ├─ resolve Agent definition
    ├─ derive capability  (parentPolicy.narrow(...))
    ├─ derive budget      (min against the parent's remaining)
    ├─ resolve model      (through the existing ModelRegistry)
    └─ construct isolated child scope
            ↓
Session → Turn → Step        (the same classes)
            ↓
ModelRuntime → EgressGate    (the same instances)
            ↓
ToolRuntime → PolicyEngine → SecretBroker → ExecutionBackend
```

Only five things are constructed fresh, each for a stated reason:

| Fresh per child    | Why                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `ContextEngine`    | §16: the child must not inherit the parent's conversation. Nothing copies into it.               |
| `FreshnessLedger`  | A parent's read receipt must not authorise a child's edit. Receipts are per-conversation claims. |
| `ToolRuntime`      | So the narrowed engine _is_ its base policy and cannot be widened later.                         |
| `FailureTracker`   | A child's doom-loop budget is its own; inheriting the parent's count would end it early.         |
| `ContextProjector` | It carries the agent/skill/briefing overlays, which are child-scoped.                            |

Everything security-relevant is shared: backend, secret broker, redactor, egress
gate (via the model runtime), policy lineage, hook definitions, session store,
edit journal.

The rejected alternative was a `AgentRun` abstraction with its own loop. It would
have been easier to reason about in isolation and would have duplicated the ten
branches of §6.1 — cancellation, retry, malformed tool calls, overflow, budget —
which is exactly where the bugs live. A second loop is a second place for
`preparing → preparing` to throw INTERNAL_ERROR on first overflow.

### 2. `agent.invoke` becomes a capability

The `AccessRequest` union gains:

```ts
interface AgentInvokeAccess {
  kind: 'agent.invoke';
  agent: string;
  depth: number; // the depth of the child being requested
  display: string;
}
```

Two reasons it is a capability rather than a bare tool call:

- **Policy can express it.** `permissions.toml` can deny one agent by name, which
  is what §11's "discovery must not imply invocation" asks for — an expressible
  policy rather than a hard-coded one.
- **Attribution.** The denial, the approval prompt and the audit record all read
  the same way as every other capability, through `describeAccess`,
  `subjectKeyOf` and `/permissions explain`.

All three builtin profiles **allow** it. That looks like a widening and is the
opposite: a child's capability is an intersection that includes its parent's, so
dispatching one grants nothing new. Denying by default would have meant the
useful case — a read-only reviewer under a read-only parent — cost an approval
prompt to do strictly nothing, and the safety would have come from the prompt
instead of from the intersection. What delegation _does_ spend is budget, and
budget is bounded separately (decision 4).

`agent.invoke` plans to an empty capability profile: a delegation performs no
filesystem, process or network effect of its own.

### 3. One event log, with child work tagged

`KernelEvent` gains `delegationId?: string`, set on every event a child session
writes. The delegation lifecycle events themselves (`delegation.requested`,
`.started`, `.completed`, `.failed`, `.cancelled`, `.denied`) are the _parent's_
and stay untagged, carrying the parent's `turnId` and `stepId`.

The alternative — a separate log per child — was rejected because the replay gate
is the milestone's hardest requirement. One ordered stream is what makes
"live == replay" checkable across a delegation boundary at all.

The tag is load-bearing in two places, and both were defects before it existed:

- **Replay attribution.** A child's `tool.call` events would otherwise be folded
  into the parent's reconstructed transcript, producing both a wrong conversation
  and a wrong terminal state.
- **Terminal state.** The root's `toolCalls`, `modelRequests` and `compactions`
  are unions over root and child (§13: root usage includes child usage), while
  each delegation's own counts are reported beside them. Live and replayed both
  compute the union and the breakdown, so a divergence names its scope.

`delegation.requested` and `delegation.started` are deliberately separate events:
the first records what was asked for, the second what was granted. The pair is
what makes the intersection auditable after the fact — "asked for 12 steps and a
workspace-dev child, got 4 steps and read-only" — which a single merged event
could not express.

### 4. Budget is a minimum, and it is charged back

```
ChildBudget = min(
  DEFAULT_CHILD_BUDGET,        // 8 steps / 8 requests / 24 tool calls / 5 min
  ParentRemainingBudget,       // ceiling − used, floored at 0
  RootSessionCeiling,
  AgentDefinition limits,
  ActiveSkill limits,
  ToolRequest
)
```

A default cap exists because without it the first delegation could spend the
parent's whole remaining allowance, and the parent would discover that when its
own next step was refused.

The child's usage is then **charged to the parent's turn**: after the batch that
dispatched it, the parent's tracker gains the child's model requests, tool calls
and cost. Without that, a parent could buy unbounded work by delegating — each
child individually within its ceiling, the total unbounded. Cost is recorded
three ways (direct, delegated, total) because §14 asks for delegated cost to be
_measurable_ before anything routes on it.

### 5. Depth defaults to 1, and the refusal is a recorded event

`maxDelegationDepth = 1`: root → child, never root → child → grandchild. A child
still _has_ the `Delegate` tool when its definition does not remove it, and the
attempt is refused inside the service — so the log contains
`delegation.requested` followed by `delegation.denied` with
`DELEGATION_DEPTH_EXCEEDED`. Refusing in the tool would have been cheaper and
would have left no record of what was attempted.

Configurable downward via `[loop] max_delegation_depth`, merged by `Math.min`
like every other loop limit, so a project can disable delegation entirely (0) but
never raise the user's ceiling.

### 6. Context is referenced, not copied

The child receives: kernel instructions, its agent definition, its active skills'
instructions, the delegated task, `contextRefs`, and the repository facts every
session gets. `contextRefs` are _names_ — the child re-reads them through its own
tools under its own policy. Passing bytes would make the parent's redaction
decisions the child's and would put unreviewed parent context in a scope that was
never granted it.

The delegated task enters the child's conversation as an `injection` naming the
parent, never as a `user` message; the child's report reaches the parent as a
`tool_result`, never as a `user` message. §18 suggests an injection for the
return path too; a tool result is a stronger form of the same guarantee, because
the content is bound to the tool call id that asked for it.

### 7. Skills become a runtime overlay, applied between steps

A skill is an instruction overlay plus a tool subset, a permission profile and a
step budget. Activation therefore declares **no** `AccessRequest`: it can only
narrow, so there is nothing to grant.

Three activation paths share one resolver (`resolveSkillActivation`): the control
plane (`/skills use`), the model-facing `Skill` tool, and an agent definition's
`skills:` list. Sharing it matters — three callers computing "which tools does
this leave me" is three chances for one of them to compute a union.

The effective scope is recomputed from the baseline on every change rather than
mutated incrementally:

```
tools  = sessionBaseline ∩ skill₁ ∩ skill₂ …
policy = basePolicy.narrow(layer₁).narrow(layer₂) …
```

`ToolRuntime` will not accept a foreign engine; it only ever derives from the
base it was constructed with (`setNarrowingLayers`). That makes "a skill cannot
widen permissions" structural rather than a rule to remember, and it makes
expiring a turn-scoped skill the same operation as activating one.

Activation is staged and applies at the next step freeze, because a step's
context and catalogue are frozen for the duration of its model request
(invariant 2) — the same rule `/model use` follows.

## Consequences

**Good**

- Subagent and skill behaviour is now testable as runtime behaviour: policy
  denials, budget exhaustion, cancellation and replay all cross the boundary.
- The intersection is stated in one function. "Narrower or equal" can be asserted
  as a property rather than case by case.
- Cost attribution exists, so the alpha.5 question ("does delegation improve
  solved-task probability enough to justify the cost?") can be answered from
  recorded runs.

**Costs and limits, stated rather than discovered later**

- **Sequential only.** The parent's step blocks while the child runs. Parallel
  subagents are a NON-GOAL (§5); the ordering is what keeps the log replayable.
- **A tool-narrowing skill disables delegation.** A skill listing `tools: [Read,
Grep]` removes `Delegate` too, for as long as it is active. Correct — a skill
  narrows every tool — and surprising enough that both the ADR and the tests say
  so.
- **The `EditJournal` is shared.** A child's edits appear in the parent's dirty
  list, which is what §30 wants. Per-delegation dirty paths are tracked from the
  child's own tool records instead.
- **`ToolResolveContext` grew.** It now carries `delegation`, `loopBudget` and two
  optional callbacks. That is a wider seam for tools than before; the alternative
  was a module-level service locator, which is worse.
- **Delegation records are flat at the root.** Every delegation in the subtree,
  including a _denied_ nested attempt, is recorded on the root session. That is
  what §14 asks for (`RootTaskCost = ParentDirectCost + Σ ChildCost`) and it is
  what keeps the live and replayed terminal states equal, since the log is one
  flat stream. The consequence at depth > 1 — not reachable with the default
  ceiling of 1 — is that a grandchild's usage would be charged to the _root's_
  turn budget rather than to its immediate parent's. That direction is
  conservative, and depth > 1 is explicitly not validated by this milestone.
- **No OS isolation.** A child is a policy scope, not a sandbox. It runs in the
  same process with the same user rights, which `describeSandbox` already says
  plainly. Container isolation is the alpha.5 candidate.
