# `v0.1.0-alpha.9` — Status

**Milestone:** MCP, and tools the kernel did not write.
**Plan:** `research/v0.1.0-alpha.9_mcp_and_foreign_tool_trust.md`.
**Baseline at kickoff:** `c9f0ddb` on `main`, two commits past the last commit
whose release gate ran green (`f99041e`).

This document is written as the milestone proceeds and is the narrative companion
to `docs/alpha9-evidence-matrix.md`. Where the two disagree, the matrix is
authoritative, because the matrix is gated and prose is not.

---

## CLOSURE A — a tag whose gate is green (§19)

### What §1 of the plan said, and what running it actually found

The plan set out the problem precisely:

```text
v0.1.0-alpha.8   tagged at c2566f4
release gate at c2566f4   RED — it contains the first broken workflow
release gate green at     f99041e
main is                   11 commits past the tag, ungated
```

Step 0 was "run the gate at the current main, fix what it finds, cut
`v0.1.0-alpha.8.1`", with the note that it should take an hour rather than a day —
"if it takes a day, that is the finding."

It found something before the gate was even dispatched. `main` was **red in CI**,
and had been for the whole of alpha.8.

### alpha.9 defect 1 — two CI jobs could not run the suite they claimed to run

`ci.yml`'s `unit-integration` (Node 22 and 24) and `platform` (ubuntu and macOS)
jobs run the full offline glob. Neither ran `pnpm install` first. That was
harmless for most of this repository's history and is harmless for most of its
jobs today — ADR-0009 means the kernel has zero runtime dependencies, and the
majority of `ci.yml`'s jobs run with no `node_modules` at all, deliberately, as
the standing demonstration of that claim.

It stopped being harmless when alpha.8 revised ADR-0019. `tests/integration/packaging.test.ts`
now **builds `dist/`** before asserting on the packed file list, because after the
dogfood the artifact under test is the built one — and it builds it by spawning
`node_modules/typescript/bin/tsc`. On a tree with no install, that is
`MODULE_NOT_FOUND`, the suite's `before` hook fails, and the seven packaging
assertions are cancelled with it.

Four job instances per push, red, for the whole milestone.

Three things kept it invisible, and they are the interesting part:

1. **Locally it cannot reproduce.** A developer checkout always has
   `node_modules`. Every one of `pnpm test`, `pnpm test:platform` and
   `pnpm test:integration` is green on this machine, at this commit, and was
   green throughout.
2. **The release gate was not affected.** Its `offline` job _does_ run
   `pnpm install --frozen-lockfile`, so the one workflow built to catch exactly
   this class of problem was the one workflow immune to it. Run `31933653742` is
   genuinely green; it just never asked the question `ci.yml` was failing.
3. **The logs were unreadable from here.** GitHub serves job logs and artifacts
   from an Azure blob host that is not reachable from this network — every
   `gh run view --log-failed`, `gh run download` and raw logs API call terminates
   in `EOF`. `ci.yml` already carried a comment about this, on the `platform`
   job: _"This job failed once on a release commit and the cause was never
   established, because GitHub serves job logs from a blob host that was
   unreachable from the machine doing the release."_ That was this defect. It was
   noticed, written down, and left unexplained for a milestone.

The cause was finally established by reproducing the _condition_ rather than
fetching the log: the tree was staged onto the native-Linux evidence host with
`git archive`, which produces a checkout with no `node_modules` and no `.git`.
The suite there reported `1053 · 951 pass · 2 fail · 7 cancelled`, and the two
failures named themselves.

**Fix.** `pnpm install --frozen-lockfile` added to those two jobs and to nothing
else. Installing everywhere would have prevented a bug fifteen jobs do not have
by erasing the evidence for ADR-0009 that those fifteen jobs currently provide.

**Regression.** `tests/lint/workflow-hazards.test.ts`, defect 17 — see below.

### alpha.9 defect 2 — a check that could not say why it failed

The same run surfaced a second, smaller thing. `teeIntoRepository` asks
`git check-ignore` whether a tee'd log is ignored, and folded `git`'s exit 128
("this is not a work tree") into its exit 1 ("not ignored"). On the exported tree
it therefore reported four correctly-ignored `ci.yml` logs as hazards, with a
message naming four filenames and no cause.

That is the safe direction — it fails rather than passes — but it is not a
diagnosable one. The check now distinguishes 128 and says which question it could
not answer.

### alpha.9 defect 3 — a checker the formatter was authoritative over

Found while writing the regression for defect 1, and the most instructive of the
three.

The new check needs to know which scripts cannot run without `node_modules`. The
signal is "builds a path into `node_modules` **and** spawns things" — the
conjunction matters, because `scripts/lint.ts` and `src/util/walk.ts` both name
`node_modules` as a directory to skip and execute nothing.

The first implementation tested the source line by line, and distinguished a real
`path.join(root, 'node_modules', 'typescript')` from an ignore list by whether the
entries were on one line or several. It worked, and `pnpm format` then reflowed
the array in the checker's own source onto a single line and broke it.

A checker whose correctness depends on source layout is a checker the formatter
is authoritative over, and the formatter runs in CI. The check now strips comments
and asks a structural question — does the name appear **inside a `join`/`resolve`
call** — which no reflow can change. Its negative control asserts the two layouts
give the same answer, which is the property that was violated rather than the
symptom that was observed.

### Defect 17 — the regression, and why it is not the obvious rule

Defect 17 generalises alpha.8's defect 13. That one was "`package:check` asserts
`dist/` exists, so something must build it first". This one is "some scripts
cannot run at all without `node_modules`, so something must install it first".
Both are a step whose precondition nothing established; both were invisible
locally, where `dist/` and `node_modules` are simply always present.

The obvious rule — _every job must install_ — is wrong here, and rejecting it is
the design decision worth recording. Most of `ci.yml` runs with no `node_modules`
on purpose. That is not an oversight to be tidied up; it is live evidence for
ADR-0009, and a rule that installed everywhere would delete it to prevent a bug
those jobs do not have.

So the set of scripts needing an install is **derived**, not declared:

```text
direct    the command invokes a devDependency binary by name (tsc, prettier)
indirect  the command loads a repository file which — following relative
          imports transitively — spawns something out of node_modules
```

The indirect arm is the one that matters. Nothing about the string `pnpm test`
suggests it needs a TypeScript compiler; the file that makes it need one is four
glob expansions away. The test also asserts the derivation is non-vacuous — that
`test` is in the derived set — so that if `packaging.test.ts` ever stops building
`dist/`, the rule goes loud rather than quietly true.

### Status of CLOSURE A

| Step                                                   | State                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| 1. do not move `v0.1.0-alpha.8`                        | done — it still points at `c2566f4`                            |
| 2. run the release gate at the current `main`          | pending — after the fixes below are pushed                     |
| 3. fix whatever it finds                               | three defects so far, all found before the gate was dispatched |
| 4. cut `v0.1.0-alpha.8.1` at that exact commit         | pending                                                        |
| 5. record that the original tag's gate is red, and why | done — `docs/alpha8-evidence-matrix.md` §7.1                   |

The plan asked whether step 0 would take an hour or a day. It took longer than an
hour, and the finding is the one §1 predicted in a different register: the
milestone that built the release gate left the _other_ workflow — the one that
runs on every push — red and unread, and the machinery for reading it did not
work from the maintainer's network. `main` being green was an assumption, and
nobody had run the thing that would have refuted it.

---

## Main milestone — MCP

Not started. See `research/v0.1.0-alpha.9_mcp_and_foreign_tool_trust.md` §24 for
the ordering; ADR-0022, ADR-0023 and ADR-0024 come first.
