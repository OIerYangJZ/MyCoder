# alpha.8 status — productization & release integrity

**Baseline:** `de37640` (`v0.1.0-alpha.7`)
**Branch:** `alpha8-productization`
**Evidence hosts:** macOS arm64 (Darwin 25.5.0) · Ubuntu 26.04 aarch64, kernel
`7.0.0-29-generic`, Landlock ABI 8, docker 29.1.3, reachable as `linux-vm`

The milestone's question was:

> Can anyone but its author install this, configure it without weakening it, and
> prove the artifact matches its evidence?

The answer at kickoff was no, in a way nobody had measured — and the most
valuable things it produced are the defects that only appeared once
somebody actually tried to install, configure and release it.

## Gates

| Gate                 | Result                                        |
| -------------------- | --------------------------------------------- |
| offline suite, macOS | 1040 tests · 947 pass · 0 fail · 93 skip      |
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
a reader audits), and `pnpm release:pack` rebuilds `dist/` every time so a stale one cannot
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

## The five that arrived after the tag

All five came from _doing_ something rather than testing it, which is the pattern
the whole milestone kept producing.

**Defect 11 — `setup-credential` recommended the path it had just refused.** Found
placing the real credential on the evidence host. Run from a shell whose cwd was
the home directory, the workspace root _was_ home, so the config directory was
inside it, so the refusal's "put it here instead" suggestion pointed inside the
workspace too. The refusal was right and the advice was nonsense. It now detects
that case and names the real problem — a session rooted somewhere far too broad.

**Defect 12 — `mycoder -m fake` with no config was refused.** A regression from
the §10 readiness check, on the offline path this repository documents in its own
README. `-m <alias>` is an explicit choice of model; the check exists to catch a
_default_ nobody chose. Caught by running `pnpm eval` — a CI job, so CI would have
found it, but only after the tag.

The last three all came from one thing: running `release.yml` for the first time.

**Defect 13 — the release gate could not build what it checks.** Its offline job
ran `pnpm package:check`, which asserts `dist/` exists, without running
`pnpm build` first. The CI `packaging` job had been given that step and this one
had not, so the gate blocked its own release on a build output it never produced.

**Defect 14 — `pnpm pack` is a pnpm builtin.** With 13 fixed, all four tiers went
green and the artifact job failed on `Unknown option: 'release'`. A `scripts.pack`
entry does not shadow the builtin; it is the other way round, so pnpm parsed the
flag and rejected it before `scripts/pack.ts` saw it. Every local run had been
`node scripts/pack.ts --release`, so the collision could not appear until
something invoked it the documented way. Renamed to `pnpm release:pack`.

**Defect 15 — the job dirtied the tree with its own log, then refused the release
for being dirty.** The step was `pnpm release:pack --release | tee pack.txt`, and
a shell creates a redirection target when it _builds_ the pipeline, before the
command on the left runs. So `pack.txt` sat untracked in the repository root by
the time `collectBuildInfo` read `git status --porcelain`. The log now goes to
`$RUNNER_TEMP`.

Three defects, in the machinery whose entire job is to be trustworthy, all of
which read correctly on review.

## Defect distribution, for the alpha.9 decision (§30)

```text
distribution / packaging   4   (2 of them fatal; 3 found only by a real install
                               or a real workflow run, never by a test)
first-run / config UX      4   (2 of them found only by doing the real thing:
                               placing a credential, and running the eval gate)
security-mechanism         2   (launcher identity, credential write ordering)
release engineering        3   (the gate could not build what it checks; the pack
                               script collided with a pnpm builtin; the pack step
                               dirtied the tree with its own log)
provider adapter           1
test-methodology           2   (a suite passing for the wrong reason; a security
                               task that stopped exercising the boundary)
boundary failures          0

Fifteen, not ten. Five more arrived *after* the tag — placing a real credential,
running the eval gate, and **three** from running the release workflow — all from
doing the real thing rather than testing it, which is the same pattern as the two
that justified the milestone in the first place.

That the release machinery accounted for three of the five is the finding worth
carrying into alpha.9. It was reviewed, it read correctly, and it was wrong in
three independent ways the first time it ran.
```

§30 says: "If alpha.8 finds mostly install/config defects, that is evidence the
product surface needs another pass before new capability." Eleven of fifteen are
distribution, first-run, config or release engineering, and three of those were
fatal — two to the artifact and one to the gate that would have shipped it. Read
literally, that points at another productization pass rather than at MCP.

Two caveats, in opposite directions.

**Against that reading:** alpha.8 had no product surface to begin with. Every one
of these is a first-attempt defect in something that did not exist a week ago, and
"the first version of a distribution had bugs" is not the same finding as "the
product surface is systematically weak". §30's heuristic assumes a surface that
existed and produced defects.

**For it:** everything alpha.8 built has been used exactly once, by its author, on
one machine. `doctor` has one real user; the exit codes have one consumer, which
is my own test suite. That is the same "only one consumer" argument used to keep
the enforcement-descriptor vocabulary experimental, and it applies here with more
force — the release machinery was reviewed, read correctly, and was wrong in three
independent ways the first time it executed.

The reading those two together support is neither: not a full productization
milestone, and not MCP immediately. A short consolidation — finish the release
gate, give the new surfaces a second user, close the remaining non-claims — and
then MCP, which is the last tool-surface gap and is measurable on day one because
the friction metric already exists.

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

### 3. The release gate is proved in four tiers of five

It has now run for real. Pushing `v0.1.0-alpha.8` triggered it and it **blocked
the release**, which is the behaviour it exists for. Four more runs followed,
fixing defects 13, 14 and 15 in turn.

The best of them, run `31931750015`, against the commit with 13 and 14 fixed:

```text
Offline Gates @ exact commit (ubuntu-latest)   success
Offline Gates @ exact commit (macos-latest)    success
Container Tier @ exact commit (REQUIRED)       success
Native Tier   @ exact commit (REQUIRED)        success
Build and verify the artifact                  failure   ← defect 15
Release Gate                                   failure   (correctly)
```

**Four of five tiers are green on runners nobody in this project controls**,
including both `_REQUIRED` enforcement tiers. GitHub's ubuntu image carries
Landlock, so the native tier genuinely ran rather than skipping — the first time
either `_REQUIRED` tier has been proved off this project's own hardware, and the
substantive half of what §18 asks for.

**The fifth is not, and the run that would have proved it never started:**

```text
The job was not started because recent account payments have failed or your
spending limit needs to be increased.
```

Under §23 that is an **`ENVIRONMENT_ERROR`** — the account's, not the code's, and
the same category as the OpenAI `insufficient_quota` that redirected §20. It is
recorded rather than worked around, and the part that is this milestone's own
fault is recorded too: five dispatches, each carrying a macOS job, which GitHub
bills at ten times the Linux rate.

|                                                           |                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| the gate blocks a release when a tier fails               | **proved**, twice, for two different causes                        |
| offline gates on both tier-1 platforms at an exact commit | **proved**                                                         |
| container tier with `KERNEL_CONTAINER_REQUIRED=1`         | **proved**                                                         |
| native tier with `KERNEL_NATIVE_REQUIRED=1`               | **proved**                                                         |
| pack → install → drive the artifact, in CI                | **not proved** — three defects found and fixed, the fix unverified |
| an end-to-end green Release Gate                          | **not proved**                                                     |

What is missing is CI doing the install unattended, not evidence that the install
works: that path was driven by hand on the evidence host twice, once from the
exact tagged artifact.

The tag is **not moved**. `v0.1.0-alpha.8` points at `c2566f4`, which contains the
first broken workflow, so its own gate run stays red — and that is the honest
record rather than an embarrassment to tidy away.

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
