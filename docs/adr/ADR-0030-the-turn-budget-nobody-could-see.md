# ADR-0030 — The turn budget nobody could see

**Status:** accepted · **Date:** 2026-08-18 · **Milestone:** v0.1.0-alpha.12 (post-tag)

## Context

A session stopped mid-task with:

```text
LOOP_BUDGET_EXCEEDED: Turn stopped: step limit reached.
```

That sentence is the whole of what the user got. It does not say what the limit
was, that it is per _turn_, that every edit already made is still on disk, or that
the next turn starts with a fresh budget. The one failure most people will meet
reads as the tool breaking.

Pulling on it found four separate problems, and only the last one is about the
number.

**The model was never told the budget existed.** The system prompt says
"Repeating a denied call wastes the turn budget" and never says what the budget
is. So the model could not pace itself, could not choose to summarise instead of
reading one more file, and could not hand back before the wall. It met the ceiling
as a cut-off mid-sentence — the one outcome that is worse than either finishing or
stopping early, because the user gets no report at all.

**`/status` and `/loop status` reported the ceiling, not the budget in force.**
After `/loop start --max-steps 2`, both still said 16. The turn then stopped at 2.
Every surface that could have explained it was showing a different number from the
one being enforced — the same defect class as the `--max-cost 999` display fixed
earlier the same day.

**The default was two numbers in two files.** `DEFAULT_LOOP_BUDGET` (`step.ts`)
and `defaultConfig().loop` (`schema.ts`) held the same four values; the second is
what a session without `[loop]` config actually runs under and the first is what
the kernel falls back to and what delegation sizes children from. They agreed, and
nothing said they had to.

**And 16 steps is too few for the work this kernel is for.** A step is one model
request plus its tool batch. Read three or four files, grep, edit, run the tests,
read the failure, fix it: ten to twenty-five steps for an ordinary task. A budget
set there stops ordinary work, not runaway work.

## Decision

**The budget is visible to everyone it binds, and the default is raised.**

```text
DEFAULT_LOOP_BUDGET / defaultConfig().loop   (spec §6.2 is amended)

  maxSteps          16  ->  40
  maxModelRequests  16  ->  40
  maxToolCalls      64  -> 160
  maxWallTimeMs    10m  -> 20m
  maxRepeatedEquivalentFailures      3 (unchanged)

SYSTEM_CEILING unchanged: 200 steps, 2000 tool calls, 200 requests, 60 minutes.
```

`maxModelRequests` tracks `maxSteps` deliberately — a step _is_ a model request
plus its tools, and two different numbers would mean one of them is the real limit
and the other is decoration. Tool calls stay at four per step, the ratio the
original figures had.

Alongside the number, three things that would have made 16 survivable:

**The model is told, every step**, as a dynamic fact: which step this is of how
many, how many tool calls are spent, and that a stopped turn with no report is the
one outcome the user cannot use. Steps and tool calls only — a wall-clock figure
in the prompt would make an identical turn non-deterministic (§31).

**The stop names the limit and the way out**: what it was, that the work is kept,
that "continue" buys a fresh budget, that `/loop start` raises it for the session
and `[loop] max_steps` for the project. The config key comes from a `switch` over
the budget fields, so a message can never name a key `schema.ts` does not read.

**`/status` and `/loop status` report the budget in force**, computed through the
same `applyCeiling` the loop uses, and name what narrowed it (`/loop start`, or a
skill) with the ceiling beside it.

## Consequences

**A turn can now spend about 2.5× what it could before, and run twice as long.**
That is the cost of the change and it is not hidden: there is still no default cost
ceiling, so `[loop] max_cost_usd` is now the setting that matters most for anyone
who cares about the ceiling on one turn's spend. The doom-loop guard (three
identical failures) and `SYSTEM_CEILING` are unchanged, so the _worst_ case — a
model looping on the same broken call — is bounded exactly as it was.

**The kernel's own `.mycoder/config.toml` no longer pins `max_steps` and
`max_tool_calls`.** They repeated the old defaults verbatim, so leaving them would
have kept this workspace — the one its author works in — on the old numbers while
everybody else moved.

**This is not a new capability, and it is close enough to one to say why.**
ADR-0027 §5 withholds capability until CLOSURE A closes: no new tool, key,
permission or reachable behaviour. `[loop] max_steps` already existed, its system
ceiling is untouched at 200, and nothing is now reachable that a one-line config
could not reach yesterday. What changed is what an unconfigured session does by
default, which is a judgement about ergonomics rather than a grant. The decision
was taken by the user on 2026-08-18 after being asked with the numbers in front of
them; it is recorded here rather than left in a commit message because "we raised
the autonomy default" is exactly the kind of change that should not be
discoverable only by `git log`.

**Spec §6.2's figures are superseded by this ADR.** The specification under
`research/` is normative and now disagrees with the code on four numbers; this ADR
is the amendment, in the open, per the precedent alpha.9 §25 set.

**The spec file itself is left untouched, deliberately.** Editing §6.2 in place was
tried and the evidence gate refused it: `docs/acceptance-suite.md` pins the
specification's sha256, and its message is _"the clauses were derived from a document
that has since changed: re-derive rather than re-hash."_ That is the gate working —
re-deriving 62 clauses by hand is a milestone-sized act that belongs to whoever owns
the suite, and re-hashing to make a build green is precisely what ADR-0027 built the
pin to prevent. So the amendment lives here, where an ADR is the mechanism for it,
until the next derivation folds it in.

## Alternatives considered

**Keep 16 and only fix the visibility.** Tempting under the freeze, and it leaves
the user hitting the same wall tonight — with a better message. The message was
never the whole problem: a budget that stops ordinary work teaches people to raise
it blindly, which is worse than a budget set where runaway work actually starts.

**Make the budget per session rather than per turn.** Rejected. Per-turn is what
makes "say continue" a real answer; a session-wide budget would turn every long
piece of work into a restart, and the number would have to be enormous to be
usable, which is the same as not having one.

**Let the model raise its own budget when it runs low.** Rejected outright. The
budget's whole purpose is to be the one limit the model cannot argue with — §15.3
already forbids a goal widening permissions, and this is the same principle
applied to spend.
