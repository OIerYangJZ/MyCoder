# CLOSURE A — the second operator

**Status: OPEN.** Prepared, not yet run.
**Date prepared:** 2026-08-16 · **Milestone:** `v0.1.0-alpha.10`
**Carried into `v0.1.0-alpha.11` unrun.** No operator was available during the
milestone that was organised around this document. See "Where this stands after
alpha.11" at the foot of the page: the consequence alpha.10 recorded against
itself has now taken effect rather than been noted again.
**Age of the open item:** sixth consecutive milestone (alpha.8 §17 first named it)

Everything from alpha.8 onward has been used once, by its author, on one machine.
This document is the protocol for changing that, and the empty findings table it
will be filled into. It is committed **before** the run, deliberately: a protocol
written after the fact is a description of what happened, not a test.

---

## Why this is the milestone's most valuable open item

alpha.9 produced six defects. Two were not first-attempt defects in new surface,
and they are the same defect twice:

```text
1  main was red on four job instances for an entire milestone, and the machinery
   for noticing was unreachable from the maintainer's network
6  /status did not show the MCP dimension — the descriptor was right, the wiring
   was right, the model was told correctly, and the single surface a *human*
   reads was wrong, and nothing failed
```

Both are **observability**: something was wrong, everything kept working, and no
mechanism existed that would have said so. A second operator is the only item on
alpha.9 §26's candidate list that can _falsify a claim the project has already
made_, and it is the mechanism that catches defect 6's whole class — because the
class is defined by a human reading a surface and being misled, and there has
only ever been one human, who wrote it.

---

## The protocol

**Do not deviate to make it go well.** A smooth run is a less useful run.

### Who

A person who is **not** the author of this repository, and who has not read its
source. Any level of programming experience; note which, because it changes how
the findings should be read.

### Where

A machine that is not this one and has no checkout of this repository. It needs
Node ≥ 22.18 and a network connection, and nothing else prepared.

### What they do, unaided

```text
1  install the packaged artifact from the tag
2  configure a model provider using only docs/configuring-a-provider.md
3  open a repository the author did not prepare — one of their own
4  run one real task they actually wanted done
5  when the agent changes something they did not want, undo it
```

Step 5 is new for alpha.10 and is the reason this run is worth having _this_
milestone rather than any other: `/undo` and the `Undo` tool have been exercised
by 32 tests and by nobody.

### What the author does

**Nothing.** No answering questions, no watching over a shoulder, no "try this
instead", no fixing the machine. If the operator is blocked, the block is the
finding. The author may be in the room only to record.

### What is recorded

**Everything they had to ask, look up, or guess, and every point at which they
were wrong about what the product would do.** Not whether they succeeded.

That last clause is the one that produces the useful data, and it is easy to
skip. "I expected `/undo` to undo the whole turn and it undid one edit" is a
finding even though nothing broke.

### How to read the result

> A run that succeeds smoothly and produces an empty list is a **suspicious**
> result, not a good one, and should be read as "the observer was too close".

---

## Predictions, recorded before the run

**Committed 2026-08-16, during alpha.11, with the run still unperformed.** They
are here so that the findings can be compared against a prediction rather than
rationalised after it, and so that a reader can tell which of the two happened.
Being wrong here is the informative outcome; five correct predictions would mean
the exercise told us only what was already known.

| #   | Where                      | What is predicted to go wrong                                                                                                     |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P1  | configuring a provider     | The highest-risk step. `api_key_file` paths are relative to the **config directory**, and nothing states that at the point of use |
| P2  | the first refusal          | A receipt error, a protected path, or an approval prompt whose subject line means nothing to someone who has not read the source  |
| P3  | `/undo`'s scope            | The model's `Undo` is capped at the turn; `/undo` is not. Nothing in the product explains why the two differ                      |
| P4  | the uncovered-set block    | Accurate, and predicted to be read as noise, because it prints on every undo including the empty case                             |
| P5  | "dirty files" in `/status` | It has said this since alpha.3 and no stranger has ever read it                                                                   |

**If the run finds none of these and finds something else entirely, that is the
best available outcome**, and it is the reason the exercise cannot be replaced by
more tests. Record it that way rather than as a failed prediction.

Two predictions about the run itself, which are about the method rather than the
product:

```text
P6  the pull toward helping will be strongest at P1, because a provider that
    will not authenticate looks like a broken product rather than a finding
P7  the operator will apologise for being confused; confusion is the datum
```

---

## Findings

_To be filled in after the run. Rows are added, never edited; a finding that
turns out to be user error is still a finding about the product's affordances._

**Empty as of `v0.1.0-alpha.11`, because the run has not happened.** An empty
table here means "not run", never "nothing found" — §13's Empty Findings Stop
says an actually-empty result from an actual run is a suspicious result requiring
its own investigation, and the two must not be able to look alike.

| #   | Moment | What they expected | What happened | Class |
| --- | ------ | ------------------ | ------------- | ----- |
|     |        |                    |               |       |

Classes: `documentation` · `affordance` · `defect` · `wrong-mental-model` ·
`blocked`.

### Questions they had to ask

| #   | Question | Where the answer was, if anywhere |
| --- | -------- | --------------------------------- |
|     |          |                                   |

---

## What must not be done instead

§13 is explicit, and it is repeated here because the substitute is tempting and
would be easy to pass off:

> Do not simulate it with a fresh VM and the author's own hands — that measures
> the artifact, which alpha.8 already did, and calls it something it is not.

alpha.8 measured the artifact: `npm install -g`, a clean host, no checkout. It
found two real defects doing so. That work is done and is not this. The variable
here is the **operator**, and an author on a fresh VM holds it constant.

---

## Status for alpha.10's release claim

`v0.1.0-alpha.10` ships with this **open**, and the release documents say so in
those words rather than omitting the row. A scheduled run is not a completed run.

alpha.9 §26 predicted this item would be skipped, and it has now been open across
alpha.8, alpha.8.1, alpha.9 and alpha.10. The plan's own rule for what that means
next:

> and if it is still open after alpha.11, the project should stop adding
> capability until it is closed.

That sentence is now a commitment this milestone is recording against itself, not
a suggestion for a future planner to weigh.

---

## Where this stands after alpha.11

`v0.1.0-alpha.11` ships with this **still open**, and it was the milestone's MAIN.
alpha.11's §1.1 said the condition had changed — "a second operator is being
arranged" — and it had not changed by the time the milestone was built. No
operator was available.

Three things were done instead of the run, and none of them is the run:

```text
the §9 predictions above, committed before it rather than after
the protocol left exactly as written, not softened to make it schedulable
the commitment allowed to take effect rather than restated a sixth time
```

**The commitment has therefore taken effect.** alpha.11 added no capability, and
the next milestone does not add capability either — not because a planner chose
that, but because alpha.9 §26 said so in advance and alpha.10 recorded it as
binding. The one thing that lifts it is an hour of somebody else's time.

What was **not** done, and is worth naming because each was available and
tempting:

```text
a fresh VM driven by the author        alpha.8 already did that; it measures
                                       the artifact and calls it the operator
an automated operator                  the author with extra steps (§6)
a colleague who has read the source    the failure mode §8 is entirely about
downgrading A1 to NOT APPLICABLE       CLOSURE C earned its downgrade by being
                                       impossible here. This one is possible,
                                       it is one hour, and it is just not done
```

That last line is the one to re-read before the next milestone. `NOT APPLICABLE`
was the right answer for the clean-resolver claim because no available machine
could ever produce it. It is the wrong answer here, and the fact that the same
move is now available and would tidy the corpus is exactly why it is refused.
