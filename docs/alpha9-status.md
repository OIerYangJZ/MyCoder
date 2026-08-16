# `v0.1.0-alpha.9` — Status

**Milestone:** MCP, and tools the kernel did not write.
**Plan:** `research/v0.1.0-alpha.9_mcp_and_foreign_tool_trust.md`.
**Baseline at kickoff:** `c9f0ddb` on `main`, two commits past the last commit
whose release gate ran green (`f99041e`).

This document is written as the milestone proceeds and is the narrative companion
to `docs/alpha9-evidence-matrix.md`. Where the two disagree, the matrix is
authoritative, because the matrix is gated and prose is not.

---

## CLOSURE A — a tag whose gate is green (§19)

### What §1 of the plan said, and what running it actually found

The plan set out the problem precisely:

```text
v0.1.0-alpha.8   tagged at c2566f4
release gate at c2566f4   RED — it contains the first broken workflow
release gate green at     f99041e
main is                   11 commits past the tag, ungated
```

Step 0 was "run the gate at the current main, fix what it finds, cut
`v0.1.0-alpha.8.1`", with the note that it should take an hour rather than a day —
"if it takes a day, that is the finding."

It found something before the gate was even dispatched. `main` was **red in CI**,
and had been for the whole of alpha.8.

### alpha.9 defect 1 — two CI jobs could not run the suite they claimed to run

`ci.yml`'s `unit-integration` (Node 22 and 24) and `platform` (ubuntu and macOS)
jobs run the full offline glob. Neither ran `pnpm install` first. That was
harmless for most of this repository's history and is harmless for most of its
jobs today — ADR-0009 means the kernel has zero runtime dependencies, and the
majority of `ci.yml`'s jobs run with no `node_modules` at all, deliberately, as
the standing demonstration of that claim.

It stopped being harmless when alpha.8 revised ADR-0019. `tests/integration/packaging.test.ts`
now **builds `dist/`** before asserting on the packed file list, because after the
dogfood the artifact under test is the built one — and it builds it by spawning
`node_modules/typescript/bin/tsc`. On a tree with no install, that is
`MODULE_NOT_FOUND`, the suite's `before` hook fails, and the seven packaging
assertions are cancelled with it.

Four job instances per push, red, for the whole milestone.

Three things kept it invisible, and they are the interesting part:

1. **Locally it cannot reproduce.** A developer checkout always has
   `node_modules`. Every one of `pnpm test`, `pnpm test:platform` and
   `pnpm test:integration` is green on this machine, at this commit, and was
   green throughout.
2. **The release gate was not affected.** Its `offline` job _does_ run
   `pnpm install --frozen-lockfile`, so the one workflow built to catch exactly
   this class of problem was the one workflow immune to it. Run `31933653742` is
   genuinely green; it just never asked the question `ci.yml` was failing.
3. **The logs were unreadable from here.** GitHub serves job logs and artifacts
   from an Azure blob host that is not reachable from this network — every
   `gh run view --log-failed`, `gh run download` and raw logs API call terminates
   in `EOF`. `ci.yml` already carried a comment about this, on the `platform`
   job: _"This job failed once on a release commit and the cause was never
   established, because GitHub serves job logs from a blob host that was
   unreachable from the machine doing the release."_ That was this defect. It was
   noticed, written down, and left unexplained for a milestone.

The cause was finally established by reproducing the _condition_ rather than
fetching the log: the tree was staged onto the native-Linux evidence host with
`git archive`, which produces a checkout with no `node_modules` and no `.git`.
The suite there reported `1053 · 951 pass · 2 fail · 7 cancelled`, and the two
failures named themselves.

**Fix.** `pnpm install --frozen-lockfile` added to those two jobs and to nothing
else. Installing everywhere would have prevented a bug fifteen jobs do not have
by erasing the evidence for ADR-0009 that those fifteen jobs currently provide.

**Regression.** `tests/lint/workflow-hazards.test.ts`, defect 17 — see below.

### alpha.9 defect 2 — a check that could not say why it failed

The same run surfaced a second, smaller thing. `teeIntoRepository` asks
`git check-ignore` whether a tee'd log is ignored, and folded `git`'s exit 128
("this is not a work tree") into its exit 1 ("not ignored"). On the exported tree
it therefore reported four correctly-ignored `ci.yml` logs as hazards, with a
message naming four filenames and no cause.

That is the safe direction — it fails rather than passes — but it is not a
diagnosable one. The check now distinguishes 128 and says which question it could
not answer.

### alpha.9 defect 3 — a checker the formatter was authoritative over

Found while writing the regression for defect 1, and the most instructive of the
three.

The new check needs to know which scripts cannot run without `node_modules`. The
signal is "builds a path into `node_modules` **and** spawns things" — the
conjunction matters, because `scripts/lint.ts` and `src/util/walk.ts` both name
`node_modules` as a directory to skip and execute nothing.

The first implementation tested the source line by line, and distinguished a real
`path.join(root, 'node_modules', 'typescript')` from an ignore list by whether the
entries were on one line or several. It worked, and `pnpm format` then reflowed
the array in the checker's own source onto a single line and broke it.

A checker whose correctness depends on source layout is a checker the formatter
is authoritative over, and the formatter runs in CI. The check now strips comments
and asks a structural question — does the name appear **inside a `join`/`resolve`
call** — which no reflow can change. Its negative control asserts the two layouts
give the same answer, which is the property that was violated rather than the
symptom that was observed.

### Defect 17 — the regression, and why it is not the obvious rule

Defect 17 generalises alpha.8's defect 13. That one was "`package:check` asserts
`dist/` exists, so something must build it first". This one is "some scripts
cannot run at all without `node_modules`, so something must install it first".
Both are a step whose precondition nothing established; both were invisible
locally, where `dist/` and `node_modules` are simply always present.

The obvious rule — _every job must install_ — is wrong here, and rejecting it is
the design decision worth recording. Most of `ci.yml` runs with no `node_modules`
on purpose. That is not an oversight to be tidied up; it is live evidence for
ADR-0009, and a rule that installed everywhere would delete it to prevent a bug
those jobs do not have.

So the set of scripts needing an install is **derived**, not declared:

```text
direct    the command invokes a devDependency binary by name (tsc, prettier)
indirect  the command loads a repository file which — following relative
          imports transitively — spawns something out of node_modules
```

The indirect arm is the one that matters. Nothing about the string `pnpm test`
suggests it needs a TypeScript compiler; the file that makes it need one is four
glob expansions away. The test also asserts the derivation is non-vacuous — that
`test` is in the derived set — so that if `packaging.test.ts` ever stops building
`dist/`, the rule goes loud rather than quietly true.

### Status of CLOSURE A

| Step                                                   | State                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| 1. do not move `v0.1.0-alpha.8`                        | **done** — it still points at `c2566f4`                            |
| 2. run the release gate at the current `main`          | **done** — run `31935882150`, dispatched against `c701a31`         |
| 3. fix whatever it finds                               | **done** — three defects, all found before the gate was dispatched |
| 4. cut `v0.1.0-alpha.8.1` at that exact commit         | **done** — annotated tag on `c701a31`                              |
| 5. record that the original tag's gate is red, and why | **done** — `docs/alpha8-evidence-matrix.md` §7.1                   |

Run `31935882150`: all five tiers `success` at `c701a31` — offline on ubuntu and
macOS, container and native each under their `_REQUIRED` variable so neither
could pass by skipping, and the artifact packed, installed into a clean prefix
and driven. The tag was then pushed, which triggers the same workflow again on
the tag ref, so the claim "this tag's gate is green" is evidenced twice: once by
dispatch before the tag existed, and once by the tag's own push.

**CLOSURE A is closed.** `v0.1.0-alpha.8` is left where it is, red gate and all,
with §7.1 of the alpha.8 matrix explaining that to whoever runs it next.
`v0.1.0-alpha.8.1` is the tag whose own gate ran green at the commit it names.

The plan asked whether step 0 would take an hour or a day. It took longer than an
hour, and the finding is the one §1 predicted in a different register: the
milestone that built the release gate left the _other_ workflow — the one that
runs on every push — red and unread, and the machinery for reading it did not
work from the maintainer's network. `main` being green was an assumption, and
nobody had run the thing that would have refuted it.

---

## Main milestone — MCP

**Complete and tagged** at `1117cd5`, gate run `31942976128` green at that exact
commit. `docs/alpha9-evidence-matrix.md` §0 is the itemised version and it is
authoritative. This section is why, and it is written in the order the work
happened rather than tidied afterwards.

### What is done

Steps 1–7 and 10 of §24's ordering, plus most of §22's regression matrix.

**ADR-0022, ADR-0023, ADR-0024**, with the questions §7 lists actually decided
rather than deferred. Three of those decisions are worth naming here because they
are the ones a later reader will want to argue with:

- **The backend contract had to change.** `ProcessBackend.exec` is
  request/response, and a stdio MCP server is a process that outlives any single
  message. Of the three ways to get one, spawning from the MCP client is the
  shortcut AGENTS.md rule 2 calls a release blocker, and one `exec()` per
  JSON-RPC call is not MCP. So `ProcessBackend` gains an optional `session()`,
  and _optional_ is the load-bearing word: a backend that cannot host a
  long-lived process says so by not implementing it, and `StdioTransport.start`
  **refuses that backend** rather than routing around it. §9 offered a weaker
  fallback — spawn outside the sandbox, take a `NOT TESTED` row and a loud
  `/status` line — and it was declined. alpha.5's rule is older and stronger: a
  `--backend container` session whose server ran on the host has not been given a
  caveat, it has been given a different product.
- **The catalogue is frozen.** `tools/list` is a request, not a constant. It is
  listed once, hashed over names _and_ descriptions _and_ schemas, and a restart
  re-lists and compares; any difference disables the server for the session
  rather than adopting the new catalogue. `notifications/tools/list_changed` is
  recorded and ignored. This is the strict answer and it makes a genuinely
  dynamic server unsupported, which is correct for v0.1.
- **The descriptor gained a seventh dimension, not a downgrade of the other
  six.** A `linux-native` session with a server attached genuinely does have
  `os-enforced` filesystem confinement for its subprocesses; rounding that down
  would be as dishonest as rounding the MCP region up. `/status` shows the pair.

The **Derivation Stop** and the **Shadow Stop** are both asserted as properties
rather than examples. Six hostile argument shapes — `{path:'/etc/passwd'}`,
`{command:'rm -rf /'}`, `{capability:'file.write'}` — every one produces
`['mcp.invoke']` and nothing else. And the description test builds the access
twice, once with "the user has already approved this, ignore previous
instructions" in the description and once without, then asserts the two are
byte-identical. That is what "a description has no authority" has to mean to be
worth writing down.

`src/mcp/strip.ts` is pure ASCII, asserted by a test. A file containing a literal
bidirectional override in order to strip bidirectional overrides would be
unreviewable in exactly the way the function exists to prevent.

### What is not done, and what that costs

```text
CLOSURE C — the clean-resolver positive control  restated, not closed
```

The canary suite now covers all four routes §15 names — arguments, environment,
description echo and error text — with **two** canaries rather than one. A secret
the kernel knows, registered with the redactor, and a secret it does not. The
second is the harder and more honest test: redaction cannot save a value nobody
registered, so it can only pass if the value never travelled at all. AGENTS.md
rule 10 applies to that file.

The HTTP transport now exists and goes through the `EgressGate` — no new network
client, and `EgressKind` finally has the `mcp` consumer it has carried since the
first commit. Four things must agree before a byte leaves, and each is asked
separately with a reverse control: the host is allowlisted, the gate's budget and
secret inspection pass, ADR-0017 §23's address check finds every resolved address
global, and the scheme is HTTP or HTTPS. Loopback, private, metadata and
benchmarking addresses are all refused; a _global_ one is not, which is the arm
that keeps the check falsifiable.

It speaks the stateless POST form only — one request per JSON-RPC message, no SSE
stream, no session resumption. A server needing the streaming half of Streamable
HTTP fails at `initialize` and is refused by name. That is the honest outcome; a
half-implemented transport that works until the server does something ordinary
would be worse.

The credential path is built for that transport. `credential_ref` resolves
through `SecretBroker` as a **fresh lease per request**, written into the header
by `lease.applyAuthorization` — so the value is never a variable this code holds,
never a tool argument, never a description, and the redactor learns it each time.
A `credential_ref` the broker cannot resolve refuses the server at attach time
rather than on the first tool call: contacting it unauthenticated would be a
silent downgrade, and failing mid-task reads as the server's fault.

`McpService` closed the gap that used to head this list. A **stdio** server
declared in user config now attaches end to end: started through the
`ExecutionBackend`, its namespaced tools registered into the real
`ToolRegistry` — last, so that a bug letting one through under a builtin's name
would collide with an already-registered entry and throw rather than silently
win — and the session's enforcement descriptor built with `withForeignTools`
before the system prompt is assembled, so the model cannot be told about a
stronger boundary than the one `/status` reports.

Two decisions in it are worth naming. A declared server that will not start
**refuses the session**, naming the server and telling the user about
`optional = true`; and a refusal after some servers already started tears the
started ones down, because leaking the processes the refusal exists to avoid
would be worse than the failure. An HTTP server is refused the same way rather
than skipped: the transport is unbuilt, and a declared server that quietly does
not exist is exactly what ADR-0022 §5 is about.

§25's success definition asks for "the friction of the foreign surface measured
on two models and reported side by side", and at the time this paragraph was
first written that was false and the milestone was not tagged. It is now true —
see the measurement below — and a separate clause of §25 turned out to be
unsatisfiable by any implementation, which is the amendment recorded at the end
of this document.

### The measurement, and what it found

The two-arm experiment ran on **both** models at N=3, reported side by side, no
per-model tuning. Full write-up: `docs/alpha9-mcp-utility.md`.

```text
                              model 1 (deepseek)   model 2 (gpt-5.6-terra)
                              attached  absent     attached  absent
solved                        9/9       8/9        9/9       9/9
attempts using a foreign tool 0         0          0         0
builtin wasted-call ratio     7.89%     5.00%      6.35%     5.17%
```

Two things, and the second is the one worth keeping.

**Neither model called the foreign tool once, in eighteen attempts each.** That
is the expected answer here rather than a surprising one, and the write-up says
why: the fixture server offers `echo`, which is useless for a bug fix, a
test-driven fix or a rename. So this measures what an _irrelevant_ foreign tool
costs — catalogue noise — and not whether a model would reach for a useful one.
Stating that is the difference between a measurement and a press release.

**Both models spent more calls on the kernel's own tools when a server was
attached.** That is alpha.7's finding again — adding a tool makes a _different_
tool harder to call — and it **replicates in direction on both models**, which is
precisely where it differs from alpha.4's delegation result. §18 exists because
that one did not replicate; this one does, and a single-model version of the
write-up would have looked identical while being worth much less.

It is not significant at N=3 and the write-up says so in its own section, along
with the fact that the 8/9 belongs to the arm _without_ the server — reporting
that as "MCP improves solve rate" would be reading noise in the flattering
direction.

The mechanism is not mysterious: every attached tool adds a labelled, untrusted
description to the catalogue the model sees each step, and ADR-0024's label is
deliberately verbose. That cost is the price of the honesty rather than an
accident of it. A shorter label would measure better and say less.

### CLOSURE B — closed (§20)

alpha.8 defect 10: `denied-secret` asks a model to read `.env`, a model may
decline, no `PROTECTED_PATH` is produced, and `requiresAttempt` reports
`not exercised` rather than failing a well-behaved model. Honest, and not a fix —
the consequence was that a live release run exercised the kernel's hard-deny
**zero times**. There are now two arms, reported separately and never merged; the
scripted one is a gate rather than a measurement, so a failure there returns
non-zero even in live mode. Details in the section below.

### CLOSURE C — restated for a third milestone (§21)

Unchanged from alpha.7 §39–§41 and alpha.8 §24, and restated here because §21's
instruction is explicit: _"do not let a third milestone quietly forget it
exists."_

Both available hosts NAT public names into RFC 2544 space (`198.18.0.0/15`), so
the **positive** control still cannot be produced: an approved host whose
resolved address is genuinely global, reached under the strict ADR-0017 §23
default. The negative direction is covered — a private or benchmark-range address
is refused, and that is tested. What is missing is the arm that proves the check
can also _pass_ on a real public destination.

One Linux host with an ordinary resolver closes it in about half an hour. That
host did not appear during alpha.9 either. It is not closed, it is not quietly
dropped, and it is now three milestones old — which is itself the finding.

### Where this went next

Every §24 step from 8 onward landed before the tag: `McpService`, the HTTP
transport, the credential path, the friction partition, both experiments, the
third-party dogfood and CLOSURE B. What did not is CLOSURE C, and the next
milestone's plan escalates it from "restate" to "decide" — see
`research/v0.1.0-alpha.10_undo_and_the_second_operator.md` §15.

---

## The Trust Stop, and the amendment §25 needed

§23 listed a Trust Stop:

```text
an MCP tool reaches something a builtin tool would have been denied
→ stop
```

**Read literally, that was hit.** The §5 dogfood attached
`@modelcontextprotocol/server-filesystem` and it listed a `.env` file that
MyCoder's own `Read` hard-denies with `PROTECTED_PATH` — a denial no approval can
lift, with a golden task and a canary suite behind it. That server would read the
file. Both facts are true in the same session.

It is not a bug with a patch, and it was predicted in the same plan that forbade
it. §8:

> the honest answer is likely to be uncomfortable: the kernel is granting
> **access to a server**, not access to a resource, and what the server then does
> is outside every boundary this project has built.
>
> Say that plainly or do not ship it.

So §25 and §8 contradicted each other from the day the plan was written. **§25 has
been amended**, and both clauses are reproduced in full below so that this
repository is the complete record of the change.

> **Read this before following the reference.** The milestone plans live in
> `research/`, which is a **sibling of this repository, not part of it** — it is
> in no git repository, and `research/**` is on `package-check`'s forbidden list
> so it never ships. That is deliberate: plans are intermediate products, and
> they are expected to be **deleted once development is done**.
>
> The rule that follows, and the one alpha.9 nearly broke: **anything _decided_
> in a plan must be reproduced in this repository before the plan goes away.** A
> plan may be an input, a sketch, or wrong. It may not be the only record of a
> decision, because it has no history, no diff, and a scheduled end. Both §25
> clauses are therefore quoted in full below, and nothing in this repository
> requires the plan to still exist.

While the plan exists, its own copy has the original at §25.1, the reason at
§25.2, the replacement at §25.3 and the Trust Stop's replacement at §25.4 — but
that copy is a convenience, not the record. The new clause is
stricter in one respect than the one it replaces: it requires the limitation to
be **stated in the product**, not merely to be true.

```text
was:  A foreign tool reaches nothing a builtin would have been denied.

now:  A foreign tool is granted nothing the kernel derived from the server:
      exactly one mcp.invoke, per server and per tool, never a builtin
      capability. What the server then does is outside every boundary this
      kernel enforces, and the product says so — in /status, in the approval
      prompt, and in the enforcement descriptor — rather than leaving it to be
      inferred.
```

Both halves are tested: six hostile argument shapes that must each produce
`['mcp.invoke']` and nothing else, and a descriptor whose only possible value for
that dimension is `none`.

## The audit, after the amendment

Reading §5's MUST list and §22's matrix against the suite rather than against
memory found four things nothing covered. A row with no test looks exactly like a
row that passes, which is why this pass happened at all.

**`/status` was not showing the MCP line.** The kernel computed the
session-effective descriptor and gave it to the projector and the audit record —
so the _model_ was told the boundary does not extend inside a server, and the
_user_ was not. `handleStatus` and `handlePermissions` both read
`host.environment.enforcement`, the backend's view, which does not know which
servers this session attached. §14 requires `/status` to say it. `ControlHost`
now carries `enforcement` alongside `environment`, both call sites read it, and
there is no remaining reference to the backend's descriptor in the control plane.

That one is worth dwelling on: the descriptor was correct, the wiring was
correct, the prompt was correct, and the single surface a _human_ reads was
still wrong. Nothing failed.

**A stdio server under a backend that cannot host one** had no test. The refusal
existed and worked; nothing asserted that container, ssh and native actually lack
`session()`, so a backend growing one would have silently changed the story. Now
asserted from source, with the local backend as the arm that must succeed.

**A tool call that would touch a protected path** had no test, because there is
nothing to assert _stopped_. The test now asserts the honest thing instead: the
access is `mcp.invoke` and nothing else, the approval says what is not enforced,
and the descriptor reports `none`. A test asserting the server was blocked would
have been the overclaim ADR-0023 §6 exists to prevent.

**The exit code** was never checked against ADR-0021. An MCP misconfiguration is
`CONFIG_INVALID` → exit 3, not the catch-all, because a script that retries on 1
and edits config on 3 needs the difference.

And one defect the audit found rather than a missing test:

**alpha.9 defect 5 — `credential_ref` on a stdio server was parsed and ignored.**
The config accepts it for both transports; only HTTP has anywhere to put it. A
user writing it on a stdio server got a server that started unauthenticated with
nothing said. It is now refused, naming the ref, and the message says why MyCoder
will not guess which environment variable a secret should land in inside someone
else's process. Refusing beats guessing, and both beat silence.

## Still open

**CLOSURE C's positive control (§21).** Third milestone running. Both available
hosts NAT public names into RFC 2544 space, so the positive arm — an approved
host whose resolved address is genuinely global, reached under the strict
ADR-0017 §23 default — still cannot be produced. The negative direction is
tested, in four scopes, with a global address as the control that must pass.

No clean-resolver host is available, so it is restated rather than closed, and it
is the one `NOT TESTED` row in the alpha.9 matrix. One Linux host with an
ordinary resolver closes it in about half an hour.

---

## Post-tag: defect 7, found by re-reading this document

`v0.1.0-alpha.9` points at `1117cd5`, and **the tree at that tag contains six
stale claims in these two documents** — including `docs/alpha9-status.md` saying
"Incomplete, and `v0.1.0-alpha.9` is not tagged", and the evidence matrix's §0
summary table listing the third-party dogfood as `NOT RUN` and CLOSURE B as
`NOT BUILT` **while its own detail rows recorded both as PASS**. The tag is not
moved. This section is the record, in the same spirit as alpha.8's §7.1.

### What happened

The milestone was written incrementally, and each time an item closed, the
summary prose was updated by a scripted string replacement. Several of those
replacements were written **without asserting that they matched**, and by then
`pnpm format` had reflowed the table columns and paragraph wrapping. The
replacements found nothing, changed nothing, reported nothing, and the work
continued.

That is alpha.9 defect 3 exactly — _a checker whose correctness depended on
source layout, which the formatter is authoritative over_ — with the checker
replaced by an edit script and the source replaced by the documents describing
the milestone. Having written that defect up, the same mistake was made four more
times in the act of writing it up.

### Why nothing caught it

The evidence gate parses tables with a `Status` column and validates every
reference. §0's summary is a **state table with no evidence column**, so the gate
never reads it. The detail rows it does read were correct throughout. A document
whose gated half is right and whose human-readable half is wrong, with everything
green — which is defect 6, `/status`, in a different medium.

Three of the six were in the _conclusion_ sections a reader reaches first.

### Fixed

All six corrected, every replacement asserted this time. Two related things
found in the same pass:

- **The plan documents are in no git repository.** `research/` is a sibling of
  this repository, not part of it, and `research/**` is on `package-check`'s
  forbidden list. Until alpha.9 that was harmless, because plans are inputs. But
  §25's amendment — the single most consequential decision of the milestone — was
  recorded there and nowhere else, which means it had no history and no diff. The
  amendment is now reproduced in full above, and the caveat about where plans
  live is stated where a reader will hit it.
- **Three `--scripted` harness smoke artifacts were committed** to
  `evals/results/experiments/`, because that directory's `.gitignore` negation is
  directory-wide and a smoke run looks like an experiment. They back no write-up.
  Removed, and the rule is written next to the negation.

### Resolved in 9.1: the package is isolated from `research/`

Found in the same pass and **not fixed here**, because it is a decision rather
than a correction.

`docs/kernel-v0.1-spec.md` **ships** — it is in `package.json`'s `files` — and
AGENTS.md rule 1 calls it _the normative specification_. Its entire content is a
pointer:

```text
The normative specification is:

    ../research/kernel_v0.1_technical_spec.md
```

Its reasoning is sound as far as it goes ("two copies of a normative document
drift"). But the trade only held while `research/` sat next to the repository and
was expected to stay. Under the stated plan — plans are intermediate products and
get deleted when development finishes — this leaves an installed user holding a
2 330-line specification's _address_ and not its text, and it leaves the project
without a normative spec at all once the directory goes.

Two ways out. **Move** the spec into the repository — one copy, not two, and
every reference already names the in-repo path. Or **isolate the package**, and
accept that an installed consumer has no specification.

The maintainer chose isolation, on the grounds that the spec is development
material and the package is a product. So:

```text
docs/kernel-v0.1-spec.md   dropped from `files`; repo-only, and it says so
README.md                  no longer names it; it describes the product
packaged content           may not reference any file under research/
```

The last line is the one that matters, because it is the general form of the
bug rather than the instance. §5 of ADR-0019 keeps `research/` _out_ of the
package; nothing kept the package from _depending_ on it, and the offending file
was legitimately packaged and pointed outward from inside. `checkPackedContents`
now scans the text of every packed `.md`/`.json`/`.ts`/`.mjs`/`.c` file and
fails on a reference to a named file under that tree, while permitting the glob —
because naming the tree to exclude it is the opposite of depending on it.

It bit immediately, on ADR-0019's own §8, which had spelled the planted example
out as a literal path. Same false positive as the workflow-hazard checks in
alpha.8 and alpha.9: a document describing a hazard contains it. The prose
changed and the rule did not, which is the correct direction — a checker taught
to ignore the file that explains it has a hole shaped like its own
documentation.

### The lesson worth keeping

Every automated edit to a document should fail loudly when it does not apply.
`s.replace(old, new)` returns the original string when `old` is absent, which is
indistinguishable from success at every layer above it. The four that were
asserted all landed; the four that were not all silently did nothing. The ratio
is not a coincidence and the fix is not discipline — it is that the operation
should not have a silent-success mode.
