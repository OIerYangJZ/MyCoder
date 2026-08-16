# ADR-0020 — The native launcher is built by an explicit step, and identified by content

**Status:** accepted · **Date:** 2026-08-16 · **Milestone:** v0.1.0-alpha.8

## Context

`--backend linux-native` runs the workload under a launcher (`native/mycoder-sandbox.c`,
ADR-0018) that applies Landlock and seccomp and then `execve`s. It is a compiled
binary in a project with zero runtime dependencies, and alpha.7 built it with
`pnpm build:sandbox` inside a git checkout, locating it at `<repo>/build/mycoder-sandbox`.

A packaged install has neither a repo nor a `build/`, and alpha.8 §16 says the
packaging question here "must not be answered by convenience". Three options, all
with real costs:

```text
prebuilt per architecture   → who signs it, and how does a user verify it
build on install            → a compiler invocation during `npm install`
explicit build step         → a user step, and a backend that refuses without it
```

alpha.7 also left a latent defect that packaging exposes. Staleness was detected
by **mtime**: the binary had to be newer than its source. Archive extraction does
not preserve that relationship — `npm`, `tar` and `git checkout` all set mtimes
from the operation, not the original — so on a packaged install the mtime test
answers a question about when files were unpacked. It can report a
correctly-built launcher as stale, and, worse, a launcher built from _different_
source as fresh.

## Decision

### 1. An explicit build step. Never `postinstall`.

```sh
mycoder build-sandbox      # or, in a checkout: pnpm build:sandbox
```

`postinstall` is rejected, not deferred. Running a C compiler as a side effect of
`npm install` is unaudited code execution triggered by dependency resolution —
the precise category ADR-0009 minimised the dependency set to avoid. A kernel
whose selling point is that it does not execute things you did not ask for cannot
introduce a compiler invocation nobody asked for, in the one place users are
least likely to read the output.

Prebuilt-per-architecture is rejected for a narrower reason: it requires a
signing and verification story — who signs, with what key, how a user checks it,
what happens on key rotation — and shipping unsigned binaries fetched at install
time would be strictly worse than shipping none. That is a real option for a
later milestone with a real release infrastructure behind it. It is not one we
can honestly do now, and half of it is worse than neither half.

The cost is accepted and made explicit: **on a packaged install, `--backend
linux-native` does not work until the user runs one command.** That command is
named in the refusal message.

### 2. Identity by content hash, not by mtime

`build-sandbox` writes the binary and, beside it, a manifest:

```jsonc
// build/mycoder-sandbox.manifest.json
{
  "sourceSha256": "<sha256 of native/mycoder-sandbox.c as built>",
  "binarySha256": "<sha256 of the produced binary>",
  "kernelVersion": "0.1.0",
  "compiler": "cc",
  "flags": ["-O2", "..."],
  "builtAt": "<iso>",
}
```

At startup the backend recomputes both hashes from what is on disk and compares.
This answers all three of §16's cases with one mechanism, and answers them
correctly on a tarball:

```text
missing manifest or binary   → LAUNCHER_MISSING
binarySha256 mismatch        → LAUNCHER_MISMATCHED   (the binary was replaced)
sourceSha256 mismatch        → LAUNCHER_STALE        (the source moved on)
```

`LAUNCHER_STALE` is the case mtime was trying to catch, and content is the right
question: a launcher built from an older `mycoder-sandbox.c` enforces the rules
that source described, while the kernel claims the rules the _current_ source
describes. That is a guarantee silently different from its documentation, which
is the failure this project treats as worse than an outage.

### 3. Every one of them refuses. None of them downgrades.

```text
--backend linux-native + any of the three  →  SANDBOX_UNSUPPORTED, session does not start
```

Never `local`. alpha.7 §9, restated because packaging is exactly the pressure
that produces "just fall back so it works" (alpha.8 §13). The refusal names the
remedy: the command to run, and the path it will write.

`/status` and the enforcement descriptors (ADR-0018) may only report
`os-isolated` for a session whose launcher verified. A packaged install with an
unverified launcher that claimed native enforcement would be an unearned security
claim on a user's machine — alpha.8 §27's Launcher Stop.

### 4. How a user verifies the launcher matches the kernel

```sh
mycoder --sandbox-status          # human
mycoder --sandbox-status --json   # scriptable
```

prints the expected and actual hashes, the verdict, and — when the verdict is not
`ok` — the remedy. This is the answer to §16's fourth question, and it is a
first-class flag rather than a debug affordance, because "does my sandbox
actually match my kernel" is a question an operator is entitled to ask without
reading source.

### 5. Where the launcher lives on a packaged install

`resolveLauncherPath()` searches, in order:

```text
1. $MYCODER_SANDBOX_BIN            explicit override (live suites, packagers)
2. <package root>/build/mycoder-sandbox
```

`<package root>` is derived from `import.meta.url`, so it is the installed tree in
a packaged install and the repository in a checkout — the same code path, no
install-mode branch. `build/` is writable in a normal per-user install (`npm
i -g` under a user prefix, `pnpm dlx`, a project-local `node_modules`). Where it
is not — a root-owned global install — the build step says so and names
`MYCODER_SANDBOX_BIN` as the way out, rather than failing with `EACCES`.

## Rationale

- The three failure cases §16 lists differ only in _why_ the launcher is wrong.
  A single content-identity check subsumes all three and, unlike mtime, keeps
  meaning after the tree has been packed, shipped and unpacked.
- Hashing two small files at startup costs well under a millisecond, on a path
  that already spends 0.5–0.8 ms per exec. There is no reason to cache it and a
  good reason not to: a cached verdict is a verdict about a file that may since
  have changed.
- "The user runs one command" is a worse first-run experience than "it just
  works". It is a better one than "it just works, and sometimes the isolation you
  were promised is not there".

## Consequences

- `sandboxBinaryState()` loses its mtime comparison and gains hash verification.
  The alpha.7 tests that asserted the mtime behaviour are rewritten to assert
  content behaviour; the _property_ under test — a stale launcher is refused — is
  unchanged, and is now true in cases where it previously was not.
- A new `LAUNCHER_*` vocabulary in `safeDetails.problem`, so a wrapper script can
  tell "you never built it" from "somebody replaced it" without parsing English.
- `build-sandbox` becomes reachable as a CLI subcommand, not only a pnpm script,
  because a packaged user has no pnpm scripts.
- The manifest is a build output and is not published in the package: shipping a
  manifest without its binary would describe a launcher that does not exist.
- Revisit when there is a signing story. Prebuilt binaries with verifiable
  provenance are the better end state; this ADR is what to do until then.
