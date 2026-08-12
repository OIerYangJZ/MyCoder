# Release checklist — `v0.1.0-alpha.1`

Plan §5. Every box must be checked from an actual command's output, not from
memory.

## Why this file exists instead of a tag

The plan ends P0/P1 with:

```bash
git tag v0.1.0-alpha.1
```

That cannot be run here: this tree is **not a git repository** (`git rev-parse`
fails from the workspace root), so there is no history to tag and no commit hash
to record in the release notes. The checklist below is what to run once the tree
is under version control; nothing about the code is waiting on it.

## Pre-tag gate

Run from `kernel/`:

```bash
pnpm install --frozen-lockfile
pnpm typecheck          # types — the only step that checks them
pnpm lint               # architecture invariants
pnpm format:check
pnpm test               # 231 tests
pnpm test:security      # AGENTS.md rule 10: this one stops everything else
pnpm test:replay        # live state == replayed state
KERNEL_TRAJECTORY_REPEATS=100 pnpm test:trajectory
pnpm eval               # 12 golden tasks, 0 secret-boundary violations
pnpm test:smoke         # on Linux, macOS and Windows
```

- [ ] `main` is green in CI (**never yet observed** — CI has not run; see
      `m2-hardening-report.md` §2)
- [ ] No release-blocking TODO in `src/`
- [ ] Spec/implementation mismatches reviewed — the known set is
      `m2-hardening-report.md` §6
- [ ] Every public-contract change has an ADR (`docs/adr/`, currently 0001–0009)
- [ ] Security suite green
- [ ] Deterministic suite green
- [ ] Release commit hash recorded below

```
release commit: __________________  (not available: not a git repository)
```

## What `alpha.1` claims

- Kernel Core structure is stable.
- The FakeModel trajectory is deterministic across 100 runs.
- The event log replays to the same terminal state as the live run.
- The 15 release-blocking security invariants have automated tests.
- CI is a release gate covering static, unit/integration, security, replay,
  determinism, golden tasks, and a three-OS smoke.

## What `alpha.1` does not claim

- No real model provider has been contacted (P2).
- Lifecycle hooks are not invoked from the turn loop.
- SSH has not run against a live host.
- Windows runs the smoke suite only.
- Isolation is `policy-enforced`, not `os-isolated`.

## After the tag

Per plan §14, the next milestone is `v0.1.0-alpha.2`: Real Model #1 (one
provider only, per §6.1) plus Control Plane validation against it. Do not start
P2 before this tag exists — that ordering is the point of the plan.
