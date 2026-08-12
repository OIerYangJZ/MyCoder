# ADR-0009 — v0.1 ships with zero runtime dependencies

**Status:** accepted · **Date:** 2026-08-12

## Context

Spec §3.2 suggests `zod`, `commander`, `fast-glob`, `ignore`, `diff` and a TOML
parser. All six are reasonable choices. But glob matching, diff generation, TOML
parsing and schema validation are all on the security path, and Node ≥ 22.6
already provides type stripping, a test runner, `fetch`, `crypto` and
`fs/promises`.

## Decision

No runtime dependencies. Glob (`util/glob.ts`), unified diff (`edit/diff.ts`),
TOML (`util/toml.ts`), JSON Schema validation (`util/jsonschema.ts`), SSE
decoding (`util/sse.ts`) and frontmatter parsing are implemented in-tree.

`typescript` and `@types/node` are devDependencies. They are not optional in
practice: Node's type stripping only verifies that syntax is _erasable_, not
that types are correct, so without a real `tsc --noEmit` the strict-mode
settings in `tsconfig.json` buy nothing. The first run of it found a
`ReferenceError` on the hook execution path that the test suite reached but
never executed.

## Rationale

- Glob semantics decide whether `**/.env` matches. That behaviour should not
  change under a transitive dependency bump.
- The kernel — and in particular the canary suite — runs with no install step and
  no network, which is exactly the property spec §31 asks for.
- The supply-chain surface of a tool that reads source code and holds credentials
  is worth more than the few hundred lines saved.

## Consequences

- Roughly 900 lines of in-tree utility code to own and test. `tests/unit/util.ts`
  covers the semantics that matter.
- The implementations are deliberate subsets: the TOML parser handles the config
  files the spec defines; the JSON Schema validator handles the tool-input subset;
  the diff falls back to a single replace hunk beyond a size ceiling rather than
  spending seconds on a minimal LCS.
- CI asserts the split: `dependencies` must be empty and `devDependencies` may
  contain only the typecheck toolchain. Adding anything else needs an ADR
  (AGENTS.md rule 6).
- Revisit if a subset becomes a real constraint.
