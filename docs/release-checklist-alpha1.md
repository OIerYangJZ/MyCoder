# Release checklist — `v0.1.0-alpha.1`

Plan §5. Every box must be checked from an actual command's output, not from
memory.

## Status: tagged

Repository: `OIerYangJZ/agent-kernel` (private)
CI run: `31580522670` on commit `c7f7a43c7e89` — twelve jobs, all green.

## Pre-tag gate

Run from `kernel/`:

```bash
pnpm install --frozen-lockfile
pnpm typecheck          # types — the only step that checks them
pnpm lint               # architecture invariants
pnpm format:check
pnpm test               # 246 tests
pnpm test:security      # AGENTS.md rule 10: this one stops everything else
pnpm test:replay        # live state == replayed state
KERNEL_TRAJECTORY_REPEATS=100 pnpm test:trajectory
pnpm eval               # 12 golden tasks, 0 secret-boundary violations
pnpm test:smoke         # on Linux, macOS and Windows
```

- [x] `main` is green in CI — run `31580334685`, all twelve jobs
- [x] No release-blocking TODO in `src/`
- [x] Spec/implementation mismatches reviewed — the known set is
      `m2-hardening-report.md` §6
- [x] Every public-contract change has an ADR (`docs/adr/`, currently 0001–0009)
- [x] Security suite green
- [x] Deterministic suite green
- [x] Release commit hash recorded below

```
release commit: c7f7a43c7e89ad25f3770718d01ac1b3fbcdba60
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
- SSH has not run against a live host.
- Windows runs the smoke suite only.
- Isolation is `policy-enforced`, not `os-isolated`.

## After the tag

Per plan §14, the next milestone is `v0.1.0-alpha.2`: Real Model #1 (one
provider only, per §6.1) plus Control Plane validation against it. Do not start
P2 before this tag exists — that ordering is the point of the plan.
