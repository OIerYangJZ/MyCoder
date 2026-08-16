# Kernel v0.1 specification — pointer

> **Not shipped.** This file is a development pointer and is deliberately absent
> from the published package (ADR-0019 §8). It resolves to `research/`, which is
> a sibling of this repository, is in no version control, and is expected to be
> deleted once development finishes. A packaged artifact that carried a pointer
> into it would hand a consumer an address instead of a document — so the package
> carries neither, and `package-check` now fails if any packaged file references
> a file under `research/` at all.

The normative specification is:

    ../research/kernel_v0.1_technical_spec.md

It is deliberately **not** duplicated here. Two copies of a normative document
drift, and when they do it is never obvious which one a reviewer read. AGENTS.md
rule 1 refers to this path; follow it to the file above.

Derived documents that _are_ maintained in this tree:

- `adr/` — decisions that interpret or extend the spec
- `threat-model.md` — adversaries, boundaries, and the honest gaps
