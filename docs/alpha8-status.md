# alpha.8 status — productization & release integrity

**Baseline:** `de37640` (`v0.1.0-alpha.7`)
**Branch:** `alpha8-productization`
**Evidence hosts:** macOS arm64 (Darwin 25.5.0) · Ubuntu 26.04 aarch64, kernel
`7.0.0-29-generic`, Landlock ABI 8, docker 29.1.3, reachable as `linux-vm`

The milestone's question was:

> Can anyone but its author install this, configure it without weakening it, and
> prove the artifact matches its evidence?

The answer at kickoff was no, in a way nobody had measured — and the two most
valuable things this milestone produced are both defects that only appeared once
somebody actually tried.

## Gates

| Gate                 | Result                                        |
| -------------------- | --------------------------------------------- |
| offline suite, macOS | 1038 tests · 945 pass · 0 fail · 93 skip      |
| architecture lint    | 16 rules, no violations                       |
| lint self-tests      | 133 · 133 pass                                |
| evidence gate        | green — 6 matrices, every claim resolves      |
| format check         | clean                                         |
| package contents     | 360 files, nothing forbidden, nothing missing |
| install dogfood      | done, on a host with no development tree      |
| container tier @ tag | 169 tests · 169 pass · 0 fail · 0 skipped     |
| native tier @ tag    | 58 tests · 58 pass · 0 fail · 0 skipped       |

## §17 — the backlog, and the defect it found

alpha.8 §65 called this "the single largest gap between _this is well built_ and
_this is releasable_", because every evidence document described a working tree
and none of it could be independently re-run.

Three commits, each verified green on its own in a throwaway worktree before the
merge:

| Commit    | Unit                                 | Offline suite at that commit |
| --------- | ------------------------------------ | ---------------------------- |
| `6237a98` | Write / Delete / Move / WebFetch     | 914 · 841 pass · 0 fail      |
| `e189e1e` | the friction metric and tool-utility | 922 · 849 pass · 0 fail      |
| `1a5bfe8` | the native Linux sandbox             | 961 · 868 pass · 0 fail      |

Then `ec6ec93` merged alpha.6 and `de37640` merged alpha.7.

**Defect 1, and the reason §17 exists.** Re-running the evidence gate at alpha.6's
own commit **failed**:

```text
evidence "test:granting network changes the plan from none to bridge, and says so
honestly" names a test/suite that appears nowhere under tests/
```

alpha.6 had rewritten that container test — the plan stopped being an open bridge
once egress was scoped — and never updated the alpha.5 row citing it by name. The
gate had been red since the milestone shipped, and nobody knew, because the gate
had only ever been run against a working tree, and the working tree it was run
against was a later one where the row had already been corrected in passing.

Fixed in `d9ba966`, and `v0.1.0-alpha.6` was placed on **that** commit rather than
on the merge. Everything else reproduced exactly: 855 · 784 pass · 0 fail · 71
skip, the numbers `docs/alpha6-status.md` already claimed.

Both tags now point at commits whose gates were re-run there.

## §25 — the install dogfood, and the two defects that justified the milestone

One session on the evidence host, from a packaged artifact, with no checkout
present. It found both of alpha.8's most important defects in its first two
commands.

**Defect 2 — the published form could not run.**

```text
Stripping types is currently unsupported for files under node_modules,
for ".../lib/node_modules/mycoder/src/cli/main.ts"
```

ADR-0019 §1 had decided to publish the TypeScript sources and let Node strip the
types, arguing that the shipped code should be byte-for-byte what the evidence ran
against. The restriction above is unconditional — no flag lifts it — and an
installed npm package lives under `node_modules` by construction. It was not a
trade-off with a cost; it was a design that could not run.

**No test in this repository could have caught it.** Every gate, and both previous
dogfoods, ran from a git checkout, where the same code works perfectly.

The ADR was re-decided in place, with the refuted reasoning kept: `tsc` emits
`dist/` at pack time, the package ships both `dist/` (what runs) and `src/` (what
a reader audits), and `pnpm pack` rebuilds `dist/` every time so a stale one cannot
ship.

**Defect 3 — the installed command did nothing and reported success.** `npm
install -g` links `<prefix>/bin/mycoder` as a symlink; Node sets `argv[1]` to the
link and `import.meta.url` to the target, so the shim's `isMain` guard was false on
every global install. No output, exit 0. The guard existed only so tests could
import the version check, so those functions moved to `bin/runtime-check.mjs` and
the entry point is now unconditionally one.

What the dogfood verified once both were fixed:

```text
install            npm install -g ./mycoder-0.1.0.tgz
first run          doctor → exit 3, names the file, the keys, the verify command
container probe    docker 29.1.3 on linux/arm64 — native Linux engine
launcher missing   --sandbox-status → exit 5, with the build command
build-sandbox      builds, writes the manifest; --sandbox-status verifies it
launcher stale     editing the shipped .c → `stale`, exit 5, and it says it would
                   enforce the rules the older source described
native session     os-isolated · Landlock ABI 8 · seccomp · no_new_privs
no downgrade       launcher removed → SANDBOX_UNSUPPORTED, exit 5, and NO local
                   session started
exit codes         2 / 2 / 2 for three usage errors, from the installed binary
```

## The other defects

**Defect 4 — a first run answered from the fake model and exited 0.**
`defaultConfig()` resolves the alias `fake`, so a machine that had never been
configured started a real session, answered its first task with
`(fake model: script exhausted)`, and reported success. §10's forbidden third
outcome dressed as the first. Fixed by telling _chosen_ apart from _defaulted
into_.

**Defect 5 — an unusable credential started a session that could not work.** It
was a warning, on the reasoning that the user might want to fix the key from
inside the session. `mycoder doctor` now serves that case without building a
kernel, so the reason expired while the failure mode did not.

**Defect 6 — the launcher's staleness check could not survive packaging.**
alpha.7 compared mtimes; npm, tar and git all set mtimes from extraction. It could
call a good launcher stale and, worse, call one built from _different source_
fresh. Identity is now by content hash.

**Defect 7 — a streamed provider error was unattributable.** The `openai-responses`
adapter read `payload.message` one level above where the API puts it, so an
account with no credit produced `MODEL_INVALID_RESPONSE: Provider stream error.`
with `blame: provider`. Found by the second provider, before it had spent
anything.

**Defect 8 — the CLI test helper was running in this repository.** Every "a fresh
install refuses" test spawned the CLI with `cwd = process.cwd()`, where the
kernel's own `.mycoder/config.toml` sets `default = "fake"`. They passed for a
reason unrelated to the code under test, and would have kept passing after the
refusal was deleted.

**Defect 9 — `setup-credential` briefly wrote a key inside the workspace.** Its
pre-write containment check compared a canonical workspace root against a lexical
target, so on macOS (where `/tmp` is a symlink) the check missed and the
post-write check removed it afterwards. A key that existed in a repository for a
millisecond has still existed in a repository.

## Defect distribution, for the alpha.9 decision (§30)

```text
distribution / packaging   3   (2 of them fatal, both found only by the dogfood)
first-run / config UX      4   (2 of them found only by doing the real thing:
                               placing a credential, and running the eval gate)
security-mechanism         2   (launcher identity, credential write ordering)
provider adapter           1
test-methodology           2   (a suite passing for the wrong reason; a security
                               task that stopped exercising the boundary)
boundary failures          0

Twelve, not ten. Two more arrived *after* the tag, both from doing the real thing
rather than testing it — the same pattern as the two that justified the milestone.
```

§30 says: "If alpha.8 finds mostly install/config defects, that is evidence the
product surface needs another pass before new capability." Five of nine are
install or config, and two of those were fatal to the artifact. That points at
another productization pass rather than at MCP — with the caveat that alpha.8 had
no product surface to begin with, so a high count here was close to guaranteed.

## Explicit non-claims

### 1. Strict public-address egress on a clean resolver (alpha.7 §39–§41)

**Restated unchanged, not closed.** Both available hosts sit behind a DNS
interception that maps every public name into RFC 2544 space, so the _positive_
control — an approved host whose resolved address is genuinely global, reached
under the strict §23 default — cannot be produced here. Every attempt is denied
for the right reason and therefore proves nothing about the permitted path.

What would close it is unchanged: any Linux host with Docker, Node and an ordinary
resolver, for about half an hour.

### 2. A live-model dogfood on the native backend (alpha.7 §57)

**Partially closed, and the remainder restated.** A packaged install ran a real
session on the native Linux backend on the evidence host, reporting `os-isolated`
with Landlock ABI 8 — so "the native backend works from an installed artifact" is
now evidence rather than a hope.

What is still not claimed is the _live-model_ half: that session ran on `fake`. No
provider credential was placed on that host, because alpha.7 §57 and alpha.8 §24
both say that is the user's decision and not the agent's. It was not asked for and
not taken.

### 3. The release workflow has never run

`.github/workflows/release.yml` encodes §18 and §27's Release Stop, and is
asserted by reading rather than by a green run — there is no configured remote CI
for this branch. The install path it automates was exercised by hand on the
evidence host, which is the part that matters most; the _gating_ logic is not yet
evidence.

## Cross-model validation (§20–§23)

Full write-up: `docs/alpha8-cross-model.md`. The three results in one line each:

- **alpha.4's delegation finding does not replicate.** 0 of 25 on model 1; **10
  of 15** on model 2, which declined the one task shape where delegating would be
  waste. The _utility_ conclusion does replicate — 5/5 solve in both arms on both
  models, and model 2 pays 50–100% more tokens for it.
- **The tool-surface finding replicates and strengthens.** New tools used 15/15
  versus 12/15; the alpha.7 `mode` fix holds on a model it was never tuned
  against.
- **A golden-set security task stopped measuring the kernel.** `denied-secret`
  went 0/5 because model 2 declined to attempt `.env` at all, so the hard-deny was
  never exercised. Its symlinked twin passed 5/5. Recorded, not patched — the fix
  changes what the golden set is.

**Defect 10**, from that last one: a security task whose success depends on the
model _attempting_ the forbidden thing silently stops testing the boundary the
moment a model gets more cautious — and fails in the direction that looks like a
regression.
