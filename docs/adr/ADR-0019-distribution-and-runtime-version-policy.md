# ADR-0019 — Distribution: publish the sources Node strips, and fail loudly on an old runtime

**Status:** accepted · **Date:** 2026-08-16 · **Milestone:** v0.1.0-alpha.8

## Context

The kernel runs as `pnpm agent` inside a git checkout, with
`node --experimental-strip-types`. That is a development workflow, not a
distribution. alpha.8 §3 asks whether someone who did not write this kernel can
install it — and today the answer is "clone the repository", which is not an
answer.

Two facts make the packaging decision less obvious than it looks:

```text
zero runtime dependencies      → packaging is unusually easy
TypeScript stripped at runtime → requires a recent Node
```

The second is a real constraint on real users, and it is the one this ADR mostly
decides.

## Decision

### 1. Published form: the TypeScript sources, stripped by Node at runtime

No build step, no emitted JavaScript, no bundler. The package contains the same
`src/**/*.ts` the test suite runs against.

The alternative — `tsc`-emitted JS — was rejected because it breaks the property
this whole milestone exists to establish. alpha.8 §3 requires "a build whose
evidence was produced by exactly that commit". Every gate in this repository
(`pnpm test`, `pnpm lint`, `pnpm evidence`) runs against the sources. If the
published artifact were emitted output, the thing a user executes would not be
the thing the evidence examined, and closing that gap would mean re-running every
suite against the emitted tree — a second evidence surface, for a benefit
(supporting an older Node) we can obtain more honestly by declaring a floor.

ADR-0009 reinforces it from the other side: with zero runtime dependencies there
is no bundling problem to solve, so a build step would buy compatibility and
nothing else.

### 2. Minimum runtime: Node >= 22.18.0

22.18.0 is the first release on the 22 line where type stripping is **on by
default**. Below it, type stripping exists but needs
`--experimental-strip-types`, which a user invoking a `bin` entry cannot pass —
so `>= 22.6` (the version that introduced the feature) is a floor the CLI cannot
actually honour, and `engines` claiming it was wrong.

### 3. How a lower runtime fails

The `bin` entry is **`bin/mycoder.mjs`, plain JavaScript with no type
annotations**. This is the whole point: a `bin` pointing directly at a `.ts` file
fails on an unsupported runtime with

```text
SyntaxError: Unexpected token ':'
```

which names neither the problem nor the remedy, and looks like a bug in the
kernel rather than a fact about the reader's Node. The shim parses on any Node
that understands ES modules, checks `process.versions.node`, and on a lower
version prints

```text
mycoder: RUNTIME_UNSUPPORTED
  This is Node <found>. MyCoder needs Node >= 22.18.0.
  <why: type stripping is on by default from 22.18.0>
  To fix: <nvm / package-manager / nodejs.org, and how to check>
```

and exits `5` (`EXIT_UNAVAILABLE`, ADR-0021). Only after that check does it
`import()` the TypeScript entry point.

The shim is written in ES2018 and uses no syntax newer than that, for the same
reason it is not TypeScript: a version check that cannot be parsed by the version
it is checking for is not a version check.

### 4. What the package contains

An explicit `files` allowlist, never `.npmignore`:

```text
bin/          the runtime-check shim
src/          the kernel
native/       the launcher source (ADR-0020)
scripts/build-sandbox.ts
docs/adr/     the decisions, which are part of understanding the boundaries
docs/*.md     the user-facing guides
README.md  LICENSE  package.json
```

### 5. What it must never contain

```text
reference/**            spec §23 — read-only trees are not ours to redistribute
research/**             milestone plans, not product
evals/**                including results/, which name models and cost money
tests/**                they carry canary fixtures; see below
.mycoder/  .env  *.key  session stores, credentials, local state
```

`tests/**` is the entry that needs justifying, because shipping tests is
otherwise a good habit and this repository believes in re-runnable evidence. It
is excluded because the security suites embed **canary secrets** — deliberately
credential-shaped strings the boundary tests hunt for. Publishing them puts a
file that looks exactly like a leaked credential onto every consumer's disk and
into every scanner's index. Evidence stays re-runnable from the repository, which
is where a person auditing the claims is going to be anyway.

`reference/**` and `research/**` are siblings of the package root and could not
be included by accident today. They are named anyway, because §9 requires this to
be a **content assertion on the packed artifact**, not a review of an ignore
file — the failure mode being guarded against is a future `files` edit, not the
current one.

### 6. Integrity, and how evidence is bound to code

`npm pack` produces a tarball with an integrity hash; the release records its
`sha256`. That says the artifact was not altered in transit, and nothing about
which commit it came from — so the package also carries `build-info.json`:

```json
{ "version": "0.1.0", "commit": "<40-hex>", "builtAt": "<iso>", "tag": "<tag|null>" }
```

written by `scripts/pack.ts` from `git rev-parse HEAD` at pack time, and reported
by `mycoder --version --json`. That is what makes "this evidence belongs to this
artifact" checkable by someone holding only the artifact: they read the commit,
and every matrix row is re-runnable at it.

A packed tree with uncommitted changes records `"commit": "<sha>-dirty"` and
`pnpm pack` refuses outright when `--release` is passed. A release artifact from
a dirty tree is the same failure as a tag on a working tree.

### 7. Supported-platform matrix, and what "supported" means

**Supported** means: the offline suite runs in CI on this platform, and a defect
found there is a release blocker.

| Platform          | Tier | What runs                                                        | Backends                       |
| ----------------- | ---- | ---------------------------------------------------------------- | ------------------------------ |
| Linux x64 / arm64 | 1    | full offline suite, container tier, native tier                  | local, container, linux-native |
| macOS arm64 / x64 | 1    | full offline suite; container tier is not release evidence (§38) | local, container               |
| Windows x64       | 2    | smoke suite only                                                 | local                          |

Tier 2 means: the parts that must hold everywhere are tested and the rest is a
known limitation, not a silent one. The full suite assumes POSIX — the local
backend spawns `sh`, fixtures use `grep` and `cat` — and `docs/m2-hardening-report.md`
has recorded that since m2. There is no container or native sandbox on Windows,
so `--backend container` and `--backend linux-native` **refuse** there; they do
not degrade (alpha.7 §9).

macOS is tier 1 for the kernel and explicitly **not** an evidence host for
container isolation: alpha.5 §38 says Docker Desktop is not equivalent to a
native Linux Engine, and that survives packaging.

## Rationale

- The strongest argument for emitted JS is a wider runtime floor. The strongest
  argument against is that it puts a transformation between the tested code and
  the shipped code, in a project whose entire release discipline is "the evidence
  belongs to this exact commit". The second argument wins, and the cost is a
  declared, checked, remediable version floor.
- A version check must be executable by the runtime it rejects. That single
  requirement is why the `bin` entry is `.mjs` and not `.ts`, and it is worth an
  extra file.
- An allowlist fails closed. A new top-level directory is absent from the package
  until someone adds it deliberately; with `.npmignore`, a new directory ships
  until someone remembers to exclude it. For a package that must never contain a
  credential, the default matters more than the convenience.

## Consequences

- Users on Node 20 cannot run this. That is a real exclusion, stated in the
  README, in `engines`, and in the failure message rather than discovered.
- `engines.node` moves from `>=22.6.0` to `>=22.18.0`. CI's Node 22 matrix entry
  now means 22.18+, which is what it already resolves to.
- Every gate keeps running against `src/`, so no evidence needs re-deriving for a
  build output that does not exist.
- The package-contents rule needs a test that packs and inspects the real
  tarball, not a review of `files`. `scripts/package-check.ts` and
  `tests/integration/packaging.test.ts` are that test.
- Revisit if a supported platform ships an LTS Node that cannot strip types, or
  if a consumer appears who genuinely cannot move off Node 20.
