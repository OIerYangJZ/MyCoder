# ADR-0019 — Distribution: ship what runs, beside what it was built from, and fail loudly on an old runtime

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

### 1. Published form: emitted JavaScript, shipped beside the sources it came from

> **Revised during alpha.8, by the install dogfood.** The first version of this
> ADR decided the opposite — publish the TypeScript sources and let Node strip
> the types — and the reasoning is kept below because the revision only makes
> sense against it.

**What the first decision said.** No build step, no emitted JavaScript, no
bundler; the package contains the same `src/**/*.ts` the test suite runs against.
`tsc`-emitted JS was rejected because it breaks the property this milestone exists
to establish: alpha.8 §3 requires "a build whose evidence was produced by exactly
that commit", every gate here runs against the sources, and if the published
artifact were emitted output then the thing a user executes would not be the thing
the evidence examined.

**Why it was wrong.** §25's install dogfood — a real `npm install -g` on a machine
with no checkout — failed on its first command with:

```text
Stripping types is currently unsupported for files under node_modules,
for ".../lib/node_modules/mycoder/src/cli/main.ts"
```

Node refuses to strip types anywhere under `node_modules`, and the refusal is
unconditional: neither `--experimental-strip-types` nor
`--experimental-transform-types` lifts it. A globally installed npm package lives
under `node_modules` by construction. So the decision was not a trade-off with a
cost; it was a design that could not run at all.

Nothing in the repository could have caught it. Every test, every gate and every
prior dogfood ran from a git checkout, where the same code works perfectly — which
is exactly why §25 asks for a machine with no development tree, and why it says
the defects found that way are the primary evidence the milestone produces.

**What is decided now.** `tsc -p tsconfig.build.json` emits `dist/` at pack time,
and `bin`/`exports` point there. `rewriteRelativeImportExtensions` does the work:
the source says `./foo.ts`, which is what lets Node run a checkout directly, and
the emitted JavaScript says `./foo.js`.

The package ships **both** `dist/` and `src/`. That is not indecision:

- `dist/` is what runs, because it must be;
- `src/` is what a reader audits, and it is what every evidence document refers
  to. For a kernel whose whole claim is a small auditable surface, "you can read
  what you ran" is worth the megabyte.

The original objection is answered rather than abandoned. `dist/` is derived
mechanically from `src/` at a commit that `build-info.json` records; `pnpm release:pack`
deletes and rebuilds it every time, so a stale `dist/` cannot ship; and the
release workflow rebuilds it at the checked-out commit and compares. ADR-0009 is
untouched — `typescript` was already a devDependency, and the _runtime_ dependency
set is still empty.

The entry shim picks between them by asking one question — is `dist/` present? —
so a checkout and an install take the same code path with no install-mode flag.

### 2. Minimum runtime: Node >= 22.18.0

22.18.0 is the first release on the 22 line where type stripping is **on by
default**. Below it, type stripping exists but needs
`--experimental-strip-types`, which a user invoking a `bin` entry cannot pass —
so `>= 22.6` (the version that introduced the feature) is a floor the CLI cannot
actually honour, and `engines` claiming it was wrong.

### 3. How a lower runtime fails, and why the entry point has no `isMain` guard

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
`import()` the kernel entry point — `dist/cli/main.js` in a package,
`src/cli/main.ts` in a checkout.

The shim is written in ES2018 and uses no syntax newer than that, for the same
reason it is not TypeScript: a version check that cannot be parsed by the version
it is checking for is not a version check.

It also has **no `isMain` guard**, and that is the second defect the install
dogfood found. `npm install -g` links `<prefix>/bin/mycoder` as a _symlink_ to the
real file under `lib/node_modules/`; Node sets `process.argv[1]` to the link and
`import.meta.url` to the target, so the usual
`import.meta.url === pathToFileURL(process.argv[1]).href` comparison is false on
every global install. The shim ran nothing, printed nothing, and exited 0 — the
installed command was a no-op that reported success.

The guard existed only so the test suite could import `checkRuntime` without
starting a session. Those functions now live in `bin/runtime-check.mjs`, which
removes the need for a guard at all: `mycoder.mjs` is unconditionally an entry
point, because that is what it is. The same bug shape as the Windows-backslash one
the guard's original comment describes, in a place nobody had looked.

### 4. What the package contains

An explicit `files` allowlist, never `.npmignore`:

```text
bin/          the entry shim and the runtime check
dist/         the emitted JavaScript — what actually runs
src/          the TypeScript it was emitted from — what a reader audits
native/       the launcher source (ADR-0020)
scripts/build-sandbox.ts
docs/adr/     the decisions, which are part of understanding the boundaries
docs/*.md     the user-facing guides
README.md  LICENSE  package.json  build-info.json
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
`pnpm release:pack --release` refuses outright on a dirty tree.

The script is **not** called `pack`: pnpm has a builtin `pnpm pack`, which shadows
a script of that name and swallows the flags before they reach it. The first real
run of the release workflow failed with `Unknown option: 'release'` for exactly
that reason — invisible locally, where it had only ever been run as
`node scripts/pack.ts`. A release artifact from
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

### 8. The package may not _depend_ on `research/` either (added alpha.9.1)

§5 keeps `research/` out of the package. That is not the same property as the
package not needing it, and the difference was live: `docs/kernel-v0.1-spec.md`
shipped, AGENTS.md rule 1 called it _the normative specification_, and its entire
content was an address under `research/`. A consumer installing the package
received the address of a 2 330-line document they did not have.

`research/` is a sibling of the repository, is in no version control, and is
expected to be **deleted once development finishes**. So the address was going to
stop resolving for everyone, not just for consumers.

Two ways out were available. Move the spec into the repository — rejected, not
because it is wrong but because it is not this ADR's call to make: relocating
what a project calls normative is an architecture decision, and the maintainer
chose the other option. **Isolate the package instead.**

```text
docs/kernel-v0.1-spec.md   no longer in `files`; a development pointer, repo-only
README.md                  no longer names it; it describes the product
packaged content           may not reference any file under research/
```

The last line is enforced rather than reviewed, by `checkPackedContents`, which
scans the text of every packed `.md`/`.json`/`.ts`/`.mjs`/`.c` file. It is a
_content_ rule where §5's are _path_ rules, and it exists because the failure
here was never a path — the offending file was legitimately in the package and
pointed outward from inside it.

`research/**` is deliberately still permitted in packaged text, including in §5's
own table above. Naming the tree in order to say it is excluded is the opposite
of depending on it; naming a **file inside it** is the dependency. The rule
encodes exactly that distinction, and its negative control asserts both halves —
a planted reference to a named file under that tree is caught, and the glob is
not.

The first run of the rule flagged **this paragraph**, because the sentence above
originally spelled the planted example out as a literal path. That is the same
false positive the workflow-hazard checks hit twice in alpha.8 and alpha.9: a
document describing a hazard contains the hazard. The rule was left alone and the
prose was changed, which is the correct direction — a checker taught to ignore
the file that explains it is a checker with a hole shaped like its own
documentation.

What this costs: an installed consumer has no specification. That is the intended
consequence and not an oversight. The spec is development material; the package
is a product; the repository is where a person auditing the claims will be
anyway, which is the same argument §5 already makes for `tests/**`.

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
