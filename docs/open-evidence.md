# Open evidence — everything this project has not established

**Gated from 2026-08-16 (alpha.11).** One index for every claim that is not
`PASS` anywhere in the evidence corpus, what would close it, and who can unblock
it.

> **This file is read by `scripts/evidence.ts`, not merely by people.** Every
> non-`PASS` row in every matrix names an entry here — `[open:A3]` — or declares
> that it is not a claim about the world at all — `[scope]` — or that a later
> milestone closed it — `[closed:C1]`, with `**Closed by alpha.N**` in its own
> notes for a human to read. The gate fails if an entry here has no row, if a row
> names an entry that is not here, if one claim carries two statuses, or if a
> closed claim still says it is open. Editing this file by hand is still how it
> changes; what has changed is that getting it wrong is now a red build.
>
> The ids are load-bearing. Renumbering an entry orphans every row that names it.

## Why this file exists

Three times now, a row has been closed by a later milestone and the original left
saying `NOT TESTED`, because nothing reconciled the matrices against each other:

```text
OS-level isolation of a child      alpha.4 said NOT TESTED; alpha.5 closed it and said so
host-scoped network allowlist      alpha.5 said "needs a proxy"; alpha.6 built the proxy
tool usability harness             alpha.7's own §B is the harness it says does not exist
```

And once, the opposite: the same claim carried `NOT APPLICABLE` in three matrices
and `NOT TESTED` in two, an hour after being downgraded.

`scripts/evidence.ts` alone caught neither. It checks that a claim **points at
something that exists**; on its own it did not check that a closed claim was
back-annotated, or that one claim carried one status. Both were legal states of a
legal document, and both were found by a person reading rather than by a build.

`scripts/evidence-corpus.ts` is the reconciliation, and this index is its
authority. The rule is unchanged and is now enforced: **an item leaves this file
only when the row that carried it is annotated in its own matrix.** Deleting from
here without that now fails the build, rather than starting the drift again.

What is still done by hand, and cannot be otherwise, is deciding **which** entry a
new non-`PASS` row belongs to. The gate insists that the row say; it cannot know
whether the answer is right.

---

## A. Blocked on a person or a machine — these are bought, not built

The whole of this section is procurable. None of it is a technical limit.

| #   | Claim                                                            | Needs                                                                  | Cost                            | Carried in                 |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- | -------------------------- |
| A1  | **A second operator has run this** (CLOSURE A)                   | One person who is not the author, on a machine that is not this one    | ~1 hour of their time           | alpha.10 §10               |
| A2  | Hostile-network behaviour: packet loss, link flapping            | root on a Linux host to inject with `tc`/`netem`                       | one sudo password, an afternoon | alpha.3                    |
| A3  | A **live-model** dogfood on the native Linux backend             | A provider credential placed on `linux-vm`                             | your decision, then ~30 min     | alpha.7 §57, alpha.8       |
| A4  | Clean direct-OpenAI behavioural validation                       | A funded OpenAI account (the current one returns `insufficient_quota`) | account top-up                  | alpha.5 §56, alpha.8       |
| A5  | Billing-grade delegated cost                                     | A vendor invoice, or per-alias published pricing, to compare against   | one account query               | alpha.4, alpha.5           |
| A6  | Windows container enforcement / Docker Desktop status            | A Windows machine                                                      | one machine                     | alpha.5, alpha.6           |
| A7  | Strict egress on a genuinely global resolved address (CLOSURE C) | One Linux host on an ordinary resolver — not behind the 198.18/15 NAT  | ~30 min once a host exists      | alpha.6/7/8/9, alpha.10 §9 |

**A7 is now `NOT APPLICABLE`, not `NOT TESTED`** — alpha.10 §15 declined a fourth
restatement. It is listed here anyway because a host would still close it, and
because ADR-0017 says the paragraph should be **deleted rather than amended** if
one appears.

### Priority, if you are only getting one thing

**A1.** It is the only item on this list that can _falsify a claim the project has
already made_, and it has been open across four milestones. Everything else
confirms or denies something already suspected; A1 can surprise.

Second: **A3**, because the native backend is where the strongest enforcement
claim lives and it has never run a real model.

---

## B. Not possible, and should never be marked otherwise

| #   | Claim                                      | Why not                                                                                                                                    |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | Native-Linux-equivalent isolation on macOS | Docker Desktop runs a Linux VM. Establishing this would require macOS to be Linux. Not hard — false.                                       |
| B2  | Fetched content cannot inject instructions | Proving a negative. Labelling, script-stripping and size caps reduce the surface and are tested; nothing closes it. `docs/threat-model.md` |

These two should stay `NOT TESTED` **forever**, and a future milestone that
"closes" them has misunderstood them. B1's honest form is already in the product:
`/status` reports the platform note itself.

---

## C. Closed elsewhere, annotated, kept for history

Not open. Listed so a reader counting `NOT TESTED` rows does not count them twice.

| #   | Claim                                     | Closed by                                      |
| --- | ----------------------------------------- | ---------------------------------------------- |
| C1  | OS-level isolation of a child             | alpha.5 — "Subagent + Container green"         |
| C2  | host-scoped network allowlist enforcement | alpha.6 — the scoped egress proxy              |
| C3  | Tool usability: success rate, step counts | alpha.7 §B — the friction table and the runner |
| C4  | a release tag whose own gate is green     | alpha.9 CLOSURE A — `v0.1.0-alpha.8.1`         |

---

## The gate that made this file checkable

Done in alpha.11, as `scripts/evidence-corpus.ts`. The three checks are §7 of
that milestone's plan and they are described at the top of this file.

The paragraph that used to be here said the gate should not be added in the same
commit as the list it gates, "because a gate added in the same commit as the list
it gates has never been run against a repository that violates it". That concern
was met a different way, and a better one: each check ships with a fixture that
**violates** it and a fixture that satisfies it
(`tests/lint/evidence-corpus.test.ts`), so every check has been run red before it
was ever run green.

It also found four things on its first run against this repository, which is the
answer to whether the corpus was clean:

```text
D1  docs/alpha6-evidence-matrix.md had never been gated at all — 83 rows,
    five milestones, and this index named it as the home of two open claims
D2  two of its rows carried the invented status "PASS — §62 closed"
D3  it had no Model provenance section, required since alpha.8
D4  its non-claims table had no Status column, so the two open claims in it
    were invisible; one row carried two claims against two different entries
```

**What the gate still does not do** is decide whether a claim is _true_. It
checks that this project's account of itself is internally consistent. A row can
say `PASS`, point at a test that exists, agree with every other row, and be
wrong; nothing here would notice, and pretending otherwise would be the overclaim
this file exists to prevent.
