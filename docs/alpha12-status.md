# v0.1.0-alpha.12 — status

**Milestone:** the acceptance suite · **Date:** 2026-08-17
**Baseline:** `v0.1.0-alpha.11` at `f68f8901d595e57a0e303e03a07e8cd9067bff64`

> **What this milestone produced is a definition, and defining a gate is not
> passing it.** The number to read is not "54 of 62 clauses covered" — that is a
> count of one document against another. It is **five**: the clauses of the
> normative specification that nothing in this repository checks, two of which are
> release-blocking invariants. They are §3 and they are the output.
>
> **And this is the last tag while CLOSURE A is open.** ADR-0027 §5, the user's
> decision, recorded as taken.

---

## 1. Gates

```text
offline suite      1364 tests · 1271 pass · 0 fail · 93 skip   (1322 at the tag)
architecture lint  16 rules · no violations
lint self-tests    250 / 250          (172 in alpha.11; +39 acceptance, +39 mirrors)
evidence gate      11 matrices · every claim resolves · corpus internally consistent
acceptance suite   62 items · 54 covered · 8 not · clause coverage re-derived
mirror checks      96 enumerations classified · 7 mirrors · every one agrees
package check      403 files · nothing forbidden, missing or dangling
SSH matrix (T1)    73 tests · loopback OpenSSH
live model (T3)    48 attempts · deepseek-chat and gpt-5.6-terra
```

The two lines that are new, and are the point of the milestone:

```text
docs/acceptance-suite.md: 62 item(s) — 54 covered, 8 not; T0 53 · T1 5 · T2 0 · T3 1 · T4 3
  clause coverage re-derived against the specification
```

The second line is load-bearing. On any machine without `research/` — CI, and every
consumer of the package — it reads `NOT re-derived`, because the normative
specification is not there. A check that could not run says so rather than passing.

### The release gate, at the commit the tag names

```text
tag        v0.1.0-alpha.12
commit     16587267216b7e85532246ebe18cb688c2535e7c
dispatch   run 32019683827 — green on every tier, before the tag existed
tag push   run 32019900190 — green on every tier, at the same commit
```

Both runs are green on all six jobs: offline gates on ubuntu **and** macOS, the
container tier with `KERNEL_CONTAINER_REQUIRED=1`, the native Landlock tier with
`KERNEL_NATIVE_REQUIRED=1`, and the artifact build. The `_REQUIRED` variables are
what make the two enforcement lines evidence rather than a runner that happened to
lack Docker — and they are also where the suite's T1 and T2 content actually lives,
since T2 has no acceptance items of its own.

**Gated twice, and the tag was not moved.** This paragraph lands in a commit _after_
both runs, deliberately: a docs-only commit before the gate means tagging an ungated
tree, and after it the gated commit is left exactly as it was gated. alpha.9 fell
into the first version of this; alpha.10 and alpha.11 got it right the same way.

## 2. MAIN — the Full Acceptance Suite

`docs/acceptance-suite.md`. 62 items: 59 clauses quoted verbatim from the
specification (§1.1 MUST, §1.2 SHOULD, §25 invariants, §28 acceptance criteria) plus
three T4 items that no specification contains and a release _candidate_ asserts.

The derivation direction is the whole design, and the git history is the proof: the
commit that created the file has **no `Status` column and no `Evidence` column**.
The mapping is the next commit. A suite derived from the test tree is a description
of the test tree, green the day it is written and indistinguishable afterwards from
one that means something.

### What deriving from the specification found that reading the tests could not

**Spec §28 already existed.** "v0.1 Acceptance Criteria", 21 unticked checkboxes,
prefixed 只有全部满足才标记 `v0.1.0`, normative since before alpha.1. Five of the 21
are covered by a test file organised around them; **no matrix, checklist or CI job
had ever enumerated it**. The project did not lack a definition of done; it lacked
anything that would notice one going unread.

**Spec §25's fifteen release-blocking invariants** are cited by number all over
`src/` and by `scripts/lint.ts`, and had never been listed against evidence in one
place. Two of them turned out to be exercised by nothing.

**"MUST 18 of 18 implemented"** has appeared in every milestone plan since alpha.7.
§1.1 has **17** bullets. The number was never re-derived and never entered this
repository, which is why no gate here could have caught it.

**T2 has zero items.** Spec §1.3 lists a cross-platform strong sandbox under
NON-GOALS, so no clause of v0.1 can require OS-level enforcement. The container
backend, the scoped egress proxy and the native Landlock sandbox — alpha.5, alpha.6,
alpha.7, three of this project's strongest milestones — answer **no clause in the
suite**. They sit above the line, not on it. ADR-0027's `rc.1` gate said "T0–T2
green", which is vacuous in its T2 half as written; §10 of the suite and the ADR now
say so rather than inventing T2 items to fill it.

## 3. The five clauses nothing checks

The output. Each says what would close it; none is closed here, because closing them
is capability work and the commitment forbids that until CLOSURE A closes.

```text
M09  the hook-network route through the egress gate — claimed in a source
     comment, exercised by nothing. Three of the clause's four routes hold
M17  FakeExecutor and FakeFileSystem do not exist. The guarantee holds via a
     temp directory and the local backend, so this is an erratum candidate
V02  invariant 2: StepContext immutability during a model request. The
     identifier appears in no test in the repository
V09  invariant 9: the large-output budget and its artifact reference. The
     mechanism exists in src/tools/runtime.ts; artifactRef is named by no test
A15  §28's "unified truncation". Redaction holds; the only truncation assertion
     is the SSH one, and the conformance suite has no truncation case at all
```

**V02 and V09 are release-blocking.** Spec §25 says violating one of its fifteen
means do not release, and neither has ever been exercised. Twelve milestones of
green builds did not surface them, and the reason is structural: every gate in this
repository checks claims that **were** made, and none looked for claims that were
never made at all.

They are now `docs/open-evidence.md` §D — a new section, because §A is "blocked on a
person or a machine" and these are blocked on nobody. `scripts/acceptance.ts`
reconciles the suite and that index in both directions.

## 4. CLOSURE A — carried, open, seventh milestone

No operator was available. It was not simulated, not automated, not downgraded, and
alpha.12 was deliberately **not** organised around it: making it the MAIN a second
time with nothing about its availability changed would have produced the same
milestone with the same outcome.

Two things changed, and only one is about the run.

**The ask got cheaper; the run did not.** `docs/second-operator-invitation.md` is one
page a stranger can be sent, and `docs/second-operator-recording-sheet.md` is a sheet
they fill in alone, so the author need not be in the room. The invitation contains no
hint, no suggested task and nothing about what the product does — the sentence doing
that work is the one refusing to answer "what is this thing?". The protocol in
`docs/alpha10-second-operator.md` is unchanged.

**It is a tier now, not a row.** ADR-0027 makes it T4 of the acceptance suite
(`R01`–`R03`) and makes T4 a precondition of `v0.1.0-rc.1`. A row can be carried
indefinitely; seven milestones is the proof. And ADR-0027 §5 — the user's decision —
makes this the last tag cut while it is open. Seven tags will have asserted that this
software is ready for somebody else, and none has been checked; the assertion is what
stops.

## 5. CLOSURE B — the enumeration audit

96 enumerations in `src/` and `scripts/`: **22 guarded, 13 declared unguarded, 61
closed by design**, every one with a verdict in
`docs/alpha12-enumeration-audit.md`. An enumeration with no row fails the build, and
so does a row naming a constant that no longer exists.

**Two mirrors had already drifted**, in a repository whose gates were green:

```text
docs/configuration-audit.md   five keys missing — four [mcp…] weakening keys and
                              one ceiling-pinned key, all added in alpha.9. The
                              document says of its own tables: "A row here that
                              were merely prose could go stale; this one fails the
                              build." Nothing read the markdown
docs/cli-contract.md          read by nothing at all. ADR-0021 promises contract
                              semantics will not change within 0.1.x, and the test
                              asserting that reads args.ts — the code, against the
                              code
```

Seven mirrors are checked now, each with a fixture that makes it fail. Three things
are **declared unguarded** with their cost rather than quietly guarded: the eleven
tool schemas (guarding them needs runtime type information, and ADR-0009 forbids the
dependency), `TRUSTED_KERNEL_HOOKS` against spec §14.5 (cheap, and simply not done),
and the one-directional README check. The detector's blind spots are named in §5 of
the audit.

## 6. CLOSURE C — a refusal that costs more

`docs/alpha12-undo-utility.md`. The refusal now arrives after two edits have landed,
leaving a half-applied rename on disk — the state alpha.11 said it had not tested.

```text
48 live attempts · deepseek-chat and gpt-5.6-terra · N=3 · four tasks · two arms
Undo available in 24, called in 0. 24/24 solved by re-reading and finishing
0/6 in the half-applied task specifically
```

**And the first live run defeated the fixture.** Version 1 armed on the read alone,
and a model that reads all three files before editing any of them had its receipt
issued while the trap was still holding off: 0 of 6 attempts produced the
difficulty. The seam gained a second trigger — the file also changes the moment the
threshold is crossed — and the v1 artifact is kept and cited rather than deleted.

The scripted smoke test passed **both** versions, because its trajectory reads and
edits one file at a time, which is exactly the ordering v1 could handle. A harness
check that only sees its own idealised trajectory validates the harness against
itself. That is the most transferable thing this closure produced.

## 7. The §9 predictions, compared

Committed in `docs/alpha12-predictions.md` before the derivation, unedited since.
Two right, three wrong.

| #   | Verdict   | What actually happened                                                                                                                                                        |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **right** | Several MUSTs are covered by tests that never name them (M05, S06, A14), and **exactly two** MUSTs came out covered by nothing — M09 and M17, the number the prediction named |
| P2  | **wrong** | The invariants are not better covered: 13/15 against 15/17 MUSTs, which is the same rate. And in severity they are _worse_ — both uncovered invariants are release-blocking   |
| P3  | **right** | M17. `FakeExecutor` and `FakeFileSystem` do not exist; the guarantee the clause exists for holds by other means, so the honest fix is a specification erratum                 |
| P4  | **wrong** | T3 and T4 hold 4 items of 62, about 6%. The surprise went the other way entirely: **T2 holds zero**, and three milestones of enforcement work answer no clause                |
| P5  | **wrong** | The suite wanted no such tier. alpha.9 §25.3's rule arrived as an ordinary T0 _item_ — V05, invariant 5 — checked by a lint rule that makes the overclaim unwriteable         |

P4 is the interesting failure: the prediction assumed the specification asks for
more than CI can reach, and the truth is that it asks for **less** than this project
has built.

## 8. Defects found in this milestone

Four were introduced by this milestone and caught inside it. That is worth listing
separately from the two pre-existing drifts in §5, because a milestone about
unchecked claims that made four is evidence about the method, not about the author.

```text
1  ADR-0027 and the suite both said nothing in the repository pointed at spec §28.
   False: agent-loop.test.ts is organised around it. Produced by a grep truncated
   at twenty lines and never re-run. Corrected in place, with the wrong version
   left visible in all three documents that carried it
2  the interference seam v1 could be defeated by read ordering (§6)
3  ADR-0027 pointed at a path under research/, which package-check forbids in a
   packaged file — docs/adr/ ships. Caught by the offline suite, not by review
4  two mirror-check fixtures were wrong first: one edited a part of the CLI
   contract the check does not read, so it proved nothing while looking exactly
   like a working check; the other required backticks the experimental block does
   not use, and reported drift that did not exist
```

### And one found after the tag was cut

Fixed on the branch, with the tag left where it is.

```text
5  docs/configuring-a-provider.md — the one document whose whole job is getting a
   stranger to a working provider — told the reader to run
   `pnpm --dir /Users/<author>/MyCoder/kernel agent -m deepseek …`. An operator who
   installed with `npm install -g` has no checkout and no pnpm; their command is
   `mycoder`, which those examples never mentioned. It also printed the author's
   own absolute path. Found by reading it while assembling the operator bundle,
   because nothing checked it — and it had shipped that way for four milestones
6  `mycoder doctor`'s footer pointed at `docs/configuration-audit.md`, a relative
   path that resolves in a checkout and nowhere else. It now resolves from the
   installed location, and a test asserts every path doctor prints exists
```

```text
7  `mycoder` run from `$HOME` refused to start with "The credential file
   ~/.config/mycoder/secrets/deepseek.key is inside the workspace … Move it
   outside the repository". The refusal is right — a workspace that wide does
   contain the config directory — but the remedy was wrong twice over: the
   credential was in exactly the right place, and following the advice would move
   a correctly-placed key somewhere worse. Found on a fresh Linux install by
   running the command in the home directory, which is the first thing anybody
   does
```

```text
8  and the refusal in 7 was **only firing for some people**. It came from the
   credential-file check, so `api_key_file` users were stopped in a home directory
   and `api_key_env` users started a session with workspace-dev write access to
   everything under it — verified on a fresh Linux install, exit 0, no warning.
   The protection was incidental
```

Defect 8 is the one that needed a decision rather than a patch, and the user took
it: **tighten**. ADR-0028 refuses a workspace that contains the user configuration
directory, before anything is built, whatever the credential source —
`WORKSPACE_CONTAINS_CONFIG`, exit 2, with `--cwd` as the remedy, and a `workspace`
finding in `doctor`. It is a refusal that now applies to more people, so it adds no
capability and relaxes nothing; what it costs is that the home directory can no
longer be a workspace at all, which the ADR records rather than glosses.

Defect 7's fix is kept and is not the fix: the credential check still refuses, and
now says which of the two things is misplaced. When the workspace contains the config directory and
the credential is inside that config directory, the problem code is
`workspace-contains-config` and the remedy names `--cwd`. Every other route keeps
`inside-workspace` and "move it outside the repository", which is right for a key
sitting in a project.

Both are now checked rather than fixed: `checkUserFacingDocs` in
`scripts/package-check.ts` refuses a fenced `pnpm` block in a user-facing document
unless it says `checkout`, and refuses an absolute home path anywhere in the package.
Five fixtures, including the two negative controls that keep the rule usable — an ADR
may describe a `pnpm` script, and prose may explain a maintainer step.

**Why this is not a tag violation.** ADR-0027 §5 forbids cutting another _tag_ while
CLOSURE A is open; it says nothing about commits, and these are documentation plus one
message string. The tag stays at `16587267216b7e85532246ebe18cb688c2535e7c`, the
branch moved on, and the post-tag commits have their own dispatch gate run recorded in
§1. What a second operator receives is built from the branch, so its provenance claim
is "built from a gated commit", not "from the tagged one" — the bundle says so.

And one methodological note, because it changed how the mapping was done: `grep` on
this machine silently returned nothing for `src/tools/builtin/shell.ts`, a file that
contains the string being searched for. Every "covered by nothing" claim in §3 was
therefore re-verified with an in-process search rather than the shell tool, and
`tests/lint/mirrors.test.ts` asserts the builtin scan finds `Shell` for that reason.

## 8.1 Two post-tag repairs that were asked for, not found

**The CLI tests could validate code that was no longer there.** `bin/mycoder.mjs`
loads `dist/cli/main.js` when it exists and falls back to `src/` only when it does
not, so a stale `dist/` silently turns every CLI test into a test of an older build —
which is how three new tests came out red against a refusal that had already been
written. `tests/helpers/cli.ts` now rebuilds when `dist/` is older than `src/`, and
`isDistStale` has both fixtures. A missing build is loudly missing; a stale one is
not.

**A turn used to print nothing until it finished.** `src/cli/render.ts` renders the
session's existing event stream — `⏺ Read(src/app.ts)` with `⎿ 1.2 kB` under it, a
spinner while the model thinks, a banner naming model, profile, isolation and cwd, and
coloured diffs. It is a **renderer, not a TUI**: spec §1.3 keeps a full TUI as a
NON-GOAL and there is no alternate screen, no panes, and no cursor addressing beyond
one line that erases itself. Zero dependencies, per ADR-0009 — the escape codes are
written out in one place with one switch, and that switch is off for `--json`, for a
pipe, for `NO_COLOR` and for `TERM=dumb`.

The design follows `reference/clio` — a Claude Code clone in the reference tree —
**read for its shape, not copied**: one accent colour (blue) on the frame, the title
and the prompt; dim labels in a column; the caveat as prose under the box rather than
squeezed into a cell; a centred frame whose width is read per print, so a resize is
followed. `reference/**` is read-only (AGENTS.md rule 3) and none of its types cross
into ours. The input frame is closed top and bottom and open at the sides — asked
for, and also the only shape a `readline` prompt can hold, since a right-hand border
would need the input line rewritten on every keystroke.

The only new plumbing is `onEvent` on `createKernel`, a pass-through to a hook
`Session` already had. No new event, no new field, no new tool: a caller that ignores
it gets exactly the previous behaviour.

**And the first draft of the banner was a real regression, caught by a test written
five milestones earlier.** It replaced the startup `/status` dump — accurate,
unreadable — with a tidy `backend: local`, and in doing so dropped the honest
isolation line that invariant 5 requires. `tests/integration/cli.test.ts` fails when
that line is missing, which is exactly what it was for (alpha.5 §41). The banner now
carries `isolation : policy-enforced — network from Shell is best-effort` and the full
caveat beneath it, both from the enforcement descriptor rather than a literal.

## 9. What alpha.12 did not do

```text
no new tool, no new capability, no new configuration key
no ADR that grants anything — ADR-0027 only withholds
no v0.1.0-rc.1: defining the gate is not passing it
none of the five uncovered clauses closed: that is capability work
no third model, no N>3
no VM run: T2's content is the release gate's own container and native jobs,
   which are a native Linux kernel rather than a Docker Desktop stand-in
```

## 10. Where this leaves the project

`v0.1.0-rc.1` now has a definition and a gate: T0–T1 green, the container and
native CI jobs green, and **T4 executed at least once**. T4 has never been executed,
and by ADR-0027 §5 nothing further is tagged until it is.

So the next milestone is not a choice between candidates. It is one hour of one
person's time, and then — with the suite in hand — the five clauses in §3, starting
with the two that are release-blocking.
