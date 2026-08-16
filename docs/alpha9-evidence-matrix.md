# `v0.1.0-alpha.9` — Evidence Matrix

**Rule (alpha.3 §32.1, unchanged since):** a checklist item without named evidence
is not PASS.

`node scripts/evidence.ts` parses this table and every earlier milestone's, and
fails the build on any `PASS` with an empty evidence cell, any reference with no
recognised `kind:` prefix, any `test:`/`suite:` naming something that appears
nowhere under `tests/`, any `artifact:` pointing at a missing or untracked file,
and any matrix with no `Model provenance` section.

Evidence prefixes: `test:` `suite:` `ci:` `eval:` `artifact:` `live:` `manual:`.

> **Read §0 first.** This milestone is **incomplete**. It is recorded here in the
> state it actually reached, with the unbuilt parts marked `NOT TESTED` rather
> than omitted, because a matrix that only lists what was finished is the exact
> failure mode alpha.8 was about.

## Model provenance

**Every row in this matrix is structural and model-independent.** A description
either reaches the model labelled or it does not; a name either collides with a
builtin or it does not; a descriptor either says `none` or it does not. None of
it depends on which model is driving.

The exception is §7, which is behavioural and names two models explicitly:

- **Model 1 — `deepseek-chat`** (DeepSeek, `openai-chat`);
- **Model 2 — `gpt-5.6-terra`** through the relay at `api1.aisz.mom`
  (`openai-chat`) — a relay, and the write-up says so again.

Same fixtures, same prompts, same N=3, no per-model tuning. Reported side by side
and never averaged (§22). Full write-up: `docs/alpha9-mcp-utility.md`, which also
states what the numbers do **not** support.

Host tier: offline suite on macOS arm64 (Darwin 25.5.0). Release gate on GitHub
runners, ubuntu-latest and macos-latest.

---

## 0. What this milestone reached, and what it did not

CLOSURE A is complete. The MCP **trust layer** is built and tested, and a
**stdio** server declared in user config now attaches end to end: `McpService`
starts it through the `ExecutionBackend`, its namespaced tools reach the real
`ToolRegistry`, and the session's enforcement descriptor reports what is not
enforced inside it.

What is still missing is the HTTP transport, the credential path, and every
measurement §17 and §18 ask for.

| Area                                           | State                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| CLOSURE A — a tag whose gate is green          | **done** — `v0.1.0-alpha.8.1`, run `31935882150`                      |
| ADR-0022, ADR-0023, ADR-0024                   | **done**                                                              |
| the capability question (§8)                   | **done** — `mcp.invoke`, decided and tested                           |
| server declaration, user-config only (§11)     | **done**                                                              |
| stdio transport through the backend (§9)       | **done** — local backend; other backends refuse                       |
| naming and provenance (§13)                    | **done**                                                              |
| untrusted descriptions (§12)                   | **done**                                                              |
| enforcement descriptors (§14)                  | **done**, and wired: the kernel applies it before building the prompt |
| HTTP transport through the EgressGate (§10)    | **done** — stateless POST form; no SSE stream                         |
| secrets via `SecretBroker` (§15)               | **done**, and the canary suite covers all four routes                 |
| lifecycle and failure (§16)                    | **done**                                                              |
| registry/session wiring                        | **done** — `McpService`, wired into `createKernel`                    |
| friction metric on MCP tools (§17)             | **done** — the builtin/foreign partition                              |
| the two-arm experiment, both models (§17, §18) | **done** — N=3, side by side, `docs/alpha9-mcp-utility.md`            |
| third-party server dogfood (§5)                | **NOT RUN**                                                           |
| CLOSURE B — the golden set's denial arm (§20)  | **NOT BUILT**                                                         |
| CLOSURE C — the clean-resolver non-claim (§21) | **restated**, not closed — see §8                                     |

**§25's success definition is therefore not met.** The sentence it asks for
contains "the friction of the foreign surface is measured on two models and
reported side by side", and that is false. `v0.1.0-alpha.9` is not tagged.

---

## 1. CLOSURE A — a tag whose gate is green (§19)

| Requirement                                         | Status | Evidence                                                                      | Notes                                                                                 |
| --------------------------------------------------- | ------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| the release gate ran at the current `main`          | PASS   | artifact:docs/alpha9-status.md                                                | Run `31935882150`, dispatched against `c701a31`                                       |
| every tier ran and passed at one exact commit       | PASS   | artifact:docs/alpha9-status.md                                                | offline ×2 platforms, container and native both `_REQUIRED`, artifact                 |
| `v0.1.0-alpha.8` was not moved                      | PASS   | artifact:docs/alpha8-evidence-matrix.md                                       | §7.1 records that its gate is red and why                                             |
| a tag exists whose own gate is green                | PASS   | artifact:docs/alpha9-status.md                                                | `v0.1.0-alpha.8.1` on `c701a31`; the tag push re-ran the gate on the tag ref          |
| **defect 1: two CI jobs could not run the suite**   | PASS   | test:defect 17: no job runs a script whose devDependencies it never installed | Red on every push for the whole of alpha.8; invisible locally and unreadable remotely |
| defect 1 has a regression that is not a memory      | PASS   | test:defect 17: NEGATIVE CONTROL — the derivation and the ordering both bite  | The needs-install set is derived from globs and imports, not declared                 |
| the derivation is non-vacuous                       | PASS   | test:defect 17: no job runs a script whose devDependencies it never installed | Asserts `test` is in the derived set, so the rule cannot go quietly true              |
| defect 2: an undiagnosable check says why it failed | PASS   | test:defect 15: no workflow tees a log into the repository                    | `git check-ignore` exit 128 is no longer folded into exit 1                           |
| defect 3: the checker is formatting-independent     | PASS   | test:defect 17: NEGATIVE CONTROL — the derivation and the ordering both bite  | Asserts one-line and reflowed layouts give the same answer                            |

---

## 2. Server declaration (§11, ADR-0022 §3)

| Requirement                                      | Status | Evidence                                                                    | Notes                                                     |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| a user config may declare stdio and HTTP servers | PASS   | test:stdio and http servers are both parsed, transport derived not declared | Transport is derived from `command`/`url`, never declared |
| a project config may **not** declare one         | PASS   | test:a project-declared server is dropped and warned about                  | The drop is loud and names what was dropped               |
| a project cannot override a user-declared server | PASS   | test:a project cannot override a user-declared server of the same name      |                                                           |
| a project **may** narrow with `use`              | PASS   | test:a project MAY narrow to a subset of user-declared servers              | The one thing a project may say, and it only subtracts    |
| `use` cannot conjure an undeclared server        | PASS   | test:`use` cannot conjure a server the user never declared                  |                                                           |
| a literal credential is refused                  | PASS   | test:a literal credential is ignored and warned about                       | Only `credential_ref` is honoured                         |
| an ambiguous transport is dropped, not guessed   | PASS   | test:a server declaring both a command and a url is dropped, not guessed    |                                                           |
| NEGATIVE CONTROL: a user declaration is kept     | PASS   | test:NEGATIVE CONTROL: the same table in USER config is kept                | A kernel with no MCP support looks identical without this |
| every new config key is audited or pinned        | PASS   | test:the audit covers every key the parser understands                      | The gate refused the build until all six were classified  |

---

## 3. Capability derivation (§8, ADR-0023) — the Derivation Stop

| Requirement                                              | Status | Evidence                                                                         | Notes                                                         |
| -------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| an MCP call produces exactly one access                  | PASS   | test:resolve emits exactly one access, and it is mcp.invoke                      | `mcp.invoke`, and nothing else                                |
| **no argument produces a builtin capability**            | PASS   | test:no argument can make it emit a builtin capability                           | Six hostile argument shapes; a property, not an example       |
| a server's self-report permits nothing                   | PASS   | test:a description asserting authority changes nothing about the access          | The access is byte-identical with and without the instruction |
| risk and `readOnly` are not derived from the server      | PASS   | test:the risk and approval subject are not derived from anything the server said | Always `high`, always `readOnly: false`                       |
| the grant is per server **and** per tool                 | PASS   | test:the access is per-server and per-tool, and says what is not enforced        |                                                               |
| NEGATIVE CONTROL: one tool's approval is not another's   | PASS   | test:NEGATIVE CONTROL: approving one tool does not cover another                 |                                                               |
| `mcp.invoke` is in `ALL_CAPABILITIES`                    | PASS   | test:it is in ALL_CAPABILITIES, so no exhaustive switch can ignore it            | The type system is the mechanism, not review                  |
| `read-only` and `review` deny it                         | PASS   | test:read-only and review deny it outright                                       | A foreign tool cannot be classified read-only                 |
| `workspace-dev` asks                                     | PASS   | test:workspace-dev asks                                                          |                                                               |
| NEGATIVE CONTROL: the profiles are not uniformly denying | PASS   | test:NEGATIVE CONTROL: the profiles differ, so the rule is not uniform           |                                                               |

---

## 4. Naming and provenance (§13, ADR-0024) — the Shadow Stop

| Requirement                                         | Status | Evidence                                                                        | Notes                                                                                 |
| --------------------------------------------------- | ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| a tool named `Read` cannot shadow the builtin       | PASS   | test:a tool called Read is namespaced and does not become the builtin           | The server never supplies the identifier                                              |
| no builtin name is reachable by any composition     | PASS   | test:every builtin name stays reachable and unshadowed                          | Over six builtin names, not one example                                               |
| two servers with the same tool name stay distinct   | PASS   | test:two servers offering the same tool name stay distinguishable               |                                                                                       |
| the audit log can say which server a call went to   | PASS   | test:the name round-trips, so the audit log can say which server                |                                                                                       |
| an illegal name is refused, never sanitised         | PASS   | test:NEGATIVE CONTROL: illegal names are refused, not cleaned up                | Sanitising is how two names become one                                                |
| an over-long identifier is refused, never truncated | PASS   | test:NEGATIVE CONTROL: an over-long identifier is refused rather than truncated |                                                                                       |
| one bad name does not cost the other tools          | PASS   | test:an illegal tool name is rejected without costing the others                |                                                                                       |
| the same holds against a **real** server            | PASS   | test:a server offering Read, Shell and Delegate shadows none of them            | A spawned process, not a fake transport                                               |
| the registry ends up with both, distinguishable     | PASS   | test:a server offering Read does not collide with the builtin                   | End to end, through `McpService` into a real `ToolRegistry`                           |
| the reserved namespace cannot be **overwritten**    | PASS   | test:the reserved namespace cannot be overwritten                               | `register` refuses duplicates; `override` is the method that could have been the hole |
| NEGATIVE CONTROL: override still works outside it   | PASS   | test:NEGATIVE CONTROL: override still works outside the namespace               | An `override` that always threw would pass the row above, and break profile narrowing |
| NEGATIVE CONTROL: a legal name is not rejected      | PASS   | test:NEGATIVE CONTROL: a legal name is not rejected                             |                                                                                       |

---

## 5. Untrusted descriptions (§12, ADR-0024)

| Requirement                                           | Status | Evidence                                                                | Notes                                                              |
| ----------------------------------------------------- | ------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| every description is labelled with its origin         | PASS   | test:the origin label comes first, so truncation cannot remove it       | The label leads, so truncation cannot remove it                    |
| a description is capped                               | PASS   | test:the origin label comes first, so truncation cannot remove it       | 1024 characters, with a visible marker                             |
| control characters, ANSI and invisibles are stripped  | PASS   | test:control characters, ANSI and invisible codepoints are removed      | Includes bidi overrides and zero-width                             |
| tab and newline survive                               | PASS   | test:tab and newline survive, because a description may have shape      |                                                                    |
| a non-string description does not become one          | PASS   | test:a non-string description does not become one                       |                                                                    |
| an instruction is shown and labelled, not filtered    | PASS   | test:an instruction in a description is still shown, and still labelled | A filter would imply it would otherwise have had authority         |
| NEGATIVE CONTROL: ordinary text survives the stripper | PASS   | test:NEGATIVE CONTROL: the stripper leaves ordinary text alone          | A stripper returning `''` would pass every assertion above         |
| the stripper's own source is reviewable               | PASS   | test:the stripper source is pure ASCII, so it can be reviewed           | Asserted, so it cannot decay into a good intention                 |
| a tool **result** is labelled untrusted too           | PASS   | test:the result is labelled with its origin                             |                                                                    |
| non-text content is described, never inlined          | PASS   | test:non-text content is described, never inlined                       | Reading media is a §6 non-goal; a blob must not arrive by accident |

---

## 6. Transports and lifecycle (§9, §10, §16)

| Requirement                                                | Status | Evidence                                                                        | Notes                                                                          |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| a stdio server is a real subprocess through the backend    | PASS   | test:initialize, tools/list and tools/call all round-trip                       | `ProcessBackend.session()`, ADR-0007 amended                                   |
| **a backend that cannot host one is refused**              | PASS   | test:a backend with no session() is refused, not worked around                  | Not spawned around the sandbox — §9's weaker fallback was declined             |
| NEGATIVE CONTROL: a backend that can, does                 | PASS   | test:NEGATIVE CONTROL: the same spec on a backend WITH session() starts         | A `start` that always threw would pass the row above                           |
| a server that never answers times out, turn survives       | PASS   | test:one that never answers times out, and the turn survives                    | `TOOL_TIMEOUT`, and the client is still usable                                 |
| a server that dies mid-call is named                       | PASS   | test:one that dies mid-call fails that call, naming the server                  | `TOOL_FAILED`, with its stderr attached                                        |
| a server that floods is capped at the framer               | PASS   | test:one that floods without framing is cut off rather than buffered            | 8 MB with no newline                                                           |
| a server that lists 500 tools is capped **and discloses**  | PASS   | test:a server that lists 500 tools is capped, and the cap is disclosed          |                                                                                |
| a cancelled turn aborts the call and kills the tree        | PASS   | test:a cancelled turn aborts the call in flight                                 | Process group kill, alpha.7 §31                                                |
| an unsupported protocol version refuses the server         | PASS   | test:an unsupported protocol version refuses the server                         |                                                                                |
| NEGATIVE CONTROL: a supported version starts               | PASS   | test:NEGATIVE CONTROL: a supported version starts, and an older one is accepted | A client refusing every version would pass the row above                       |
| a catalogue that changes disables the server               | PASS   | test:a changed description is detected, not adopted                             | Names, descriptions and schemas are all in the hash                            |
| a disabled server refuses further calls, naming why        | PASS   | test:a disabled server refuses further calls, naming why                        |                                                                                |
| NEGATIVE CONTROL: an unchanged catalogue reconciles        | PASS   | test:NEGATIVE CONTROL: an unchanged catalogue reconciles cleanly                | An always-"changed" comparison would pass both rows above                      |
| **an HTTP server goes through the EgressGate**             | PASS   | test:a full session works, and every byte went through the gate                 | No new network client; `EgressKind` finally has its `mcp` consumer             |
| **an HTTP host that is not allowlisted is refused**        | PASS   | test:a host that is not allowlisted is refused                                  | And the transport is never reached                                             |
| **an HTTP host resolving to a private address is refused** | PASS   | test:a host that resolves to a private address is refused before connecting     | Loopback, private, metadata and benchmarking, all four                         |
| NEGATIVE CONTROL: a global address is not refused          | PASS   | test:NEGATIVE CONTROL: a global address is NOT refused                          | A check refusing every address would pass the row above and make HTTP unusable |
| a non-HTTP scheme is refused                               | PASS   | test:a non-HTTP scheme is refused                                               |                                                                                |
| a server that fails to start refuses the session           | PASS   | test:refuses the session by default, naming the server and the remedy           | Names the server and the remedy, per ADR-0022 section 5                        |
| `optional = true` starts the session without it, loudly    | PASS   | test:`optional = true` starts the session without it, loudly                    | A warning and no tools, never a silent gap                                     |
| a refusal does not leave other servers half-attached       | PASS   | test:one failing server does not leave the others half-attached                 | Leaking the process the refusal avoids would be worse than the failure         |
| an HTTP server with no gate is refused, not routed around  | PASS   | test:an HTTP server with no egress gate is refused, not routed around           | There is not supposed to be another way to the network                         |

---

## 7. Secrets, measurement and the dogfood (§15, §17, §18, §5)

| Requirement                                                            | Status | Evidence                                                                                 | Notes                                                                            |
| ---------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| an ambient credential does not reach a stdio server                    | PASS   | test:a credential-shaped variable in the ambient environment does not reach it           | Asked **of the server**, which reports its own environment                       |
| NEGATIVE CONTROL: the fixture can see what it is given                 | PASS   | test:NEGATIVE CONTROL: the echo-env fixture can see what it IS given                     | A fixture returning `{}` would pass the row above whatever the kernel did        |
| a literal credential in config is refused                              | PASS   | test:a literal credential is ignored and warned about                                    |                                                                                  |
| **a credential reaches a server only via SecretBroker**                | PASS   | test:authorize writes the header, and it is the only place the value appears             | A fresh lease per request; the value is never a variable this code holds         |
| a credential never reaches the request body                            | PASS   | test:authorize writes the header, and it is the only place the value appears             | A tool argument is the route section 15 forbids first                            |
| NEGATIVE CONTROL: no credential, no header                             | PASS   | test:NEGATIVE CONTROL: with no authorize, no authorization header is sent                |                                                                                  |
| an unresolvable credential_ref refuses the server                      | PASS   | test:an HTTP server with no egress gate is refused, not routed around                    | Contacting it unauthenticated would be a silent downgrade                        |
| **the canary suite is extended to MCP sinks**                          | PASS   | test:neither canary is on the wire, in any request the kernel sent                       | Two canaries: one the kernel knows, one it does not                              |
| the environment route carries neither canary                           | PASS   | test:neither canary reaches a stdio server through the environment                       | Asked of the server, not of `scrubEnv`                                           |
| a description asking for a secret gets no secret                       | PASS   | test:a description that asks for a secret gets a labelled description, not a secret      | There is no code path from a description to an argument                          |
| an error echoing the request carries no secret out                     | PASS   | test:an error result echoing the request does not carry a secret out                     | The route easiest to forget, since it is written after something went wrong      |
| NEGATIVE CONTROL: the recorder does capture traffic                    | PASS   | test:NEGATIVE CONTROL: the recording gate does capture request bodies                    | An empty wire would prove every row above                                        |
| NEGATIVE CONTROL: the fixture reports its environment                  | PASS   | test:NEGATIVE CONTROL: the fixture does report the environment it is given               | A fixture returning nothing would pass the environment row                       |
| **the friction metric covers MCP tools**                               | PASS   | test:calls, errors, repeats and codes are all counted for an MCP tool                    | Counted already; alpha.9 adds the builtin/foreign partition                      |
| the builtin half is readable in both arms                              | PASS   | test:the builtin half is readable in both arms, which is the actual question             | The total hides the number the question is about                                 |
| NEGATIVE CONTROL: the split is real                                    | PASS   | test:NEGATIVE CONTROL: the split is not a rename of the whole table                      | A split putting everything in one half would pass the arm comparison             |
| **a two-arm experiment, server present vs absent**                     | PASS   | eval:evals/experiments/mcp-utility.ts                                                    | 3 tasks x 2 arms x N=3; each arm asserts its own premise                         |
| each arm asserts its own premise before the turn                       | PASS   | artifact:evals/experiments/mcp-utility-fixtures.ts                                       | A silent prepare failure would compare the control against itself                |
| **the experiment is run on both models (section 18)**                  | PASS   | artifact:docs/alpha9-mcp-utility.md                                                      | Same fixtures, same prompts, same N, no per-model tuning                         |
| results are reported side by side, never averaged                      | PASS   | artifact:docs/alpha9-mcp-utility.md                                                      | Model 2 is named as a relay again                                                |
| model 1 artifact is readable                                           | PASS   | artifact:evals/results/experiments/mcp-utility-deepseek-3x-2026-08-16T09-58-54-218Z.json |                                                                                  |
| model 2 artifact is readable                                           | PASS   | artifact:evals/results/experiments/mcp-utility-relay-3x-2026-08-16T10-09-49-762Z.json    |                                                                                  |
| the finding replicates across models                                   | PASS   | artifact:docs/alpha9-mcp-utility.md                                                      | Builtin friction rises in both arms on both models -- unlike alpha.4 delegation  |
| the write-up states what it does NOT support                           | PASS   | artifact:docs/alpha9-mcp-utility.md                                                      | Not significant at N=3; zero uses is partly by construction                      |
| **a dogfood against a third-party server**                             | PASS   | artifact:docs/alpha9-mcp-dogfood.md                                                      | `@modelcontextprotocol/server-filesystem`, fetched from npm, not vendored        |
| 14 foreign tools registered, no builtin shadowed                       | PASS   | artifact:docs/alpha9-mcp-dogfood.md                                                      | `Read` intact alongside 14 namespaced names                                      |
| every third-party description arrived labelled                         | PASS   | artifact:docs/alpha9-mcp-dogfood.md                                                      | 0 unlabelled of 14                                                               |
| **the server reached a path the kernel hard-denies**                   | PASS   | artifact:docs/alpha9-mcp-dogfood.md                                                      | It listed `.env`. This is `foreignToolEffects: none` made concrete, not a defect |
| defect 4: the configured timeout could not raise the handshake ceiling | PASS   | artifact:docs/alpha9-mcp-dogfood.md                                                      | Found on the first real server; a ceiling nobody can raise is not a default      |

---

## 8. CLOSURE B and CLOSURE C

| Requirement                                              | Status     | Evidence                                                         | Notes                                                                                        |
| -------------------------------------------------------- | ---------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **CLOSURE B — a scripted arm that forces the hard-deny** | PASS       | artifact:docs/alpha9-status.md                                   | `runTask({forceScripted})`; runs for every requiresAttempt task in a live run                |
| both arms are reported, neither substituting             | PASS       | artifact:docs/alpha9-status.md                                   | Separate section; the scripted arm is never folded into the live totals                      |
| the scripted arm is a gate, not a measurement            | PASS       | artifact:evals/runners/run.ts                                    | A failure there returns 1 even in live mode: it is a fact about the kernel                   |
| every requiresAttempt task can be forced                 | PASS       | test:every requiresAttempt check belongs to a task with a script | A task the arm silently skips looks exactly like one that passed                             |
| NEGATIVE CONTROL: the arm is not vacuous                 | PASS       | test:NEGATIVE CONTROL: there is at least one such task           | Deleting requiresAttempt everywhere would satisfy the row above                              |
| **CLOSURE C — strict egress on a clean resolver**        | NOT TESTED | artifact:docs/alpha9-status.md                                   | §21. Restated for a third milestone; both available hosts still NAT public names into 198.18 |
| CLOSURE C is restated rather than forgotten              | PASS       | artifact:docs/alpha9-status.md                                   | The plan's explicit instruction: "do not let a third milestone quietly forget it exists"     |

---

### 6.1 Configuration to a running server, end to end

| Requirement                                            | Status | Evidence                                                                | Notes                                             |
| ------------------------------------------------------ | ------ | ----------------------------------------------------------------------- | ------------------------------------------------- |
| a declared server's tools reach a real registry        | PASS   | test:the tools reach a real ToolRegistry under namespaced names         | `Read` and the namespaced echo tool, side by side |
| attaching one changes what `/status` may say           | PASS   | test:attaching a server changes what /status is allowed to say          | The descriptor is applied in `createKernel`, once |
| NEGATIVE CONTROL: with none, `/status` is silent on it | PASS   | test:NEGATIVE CONTROL: with no servers, /status says nothing about them |                                                   |

---

## 9. Gates at this commit

| Gate               | Result                                                   |
| ------------------ | -------------------------------------------------------- |
| offline suite      | 1148 · 1055 pass · 0 fail · 93 skip (see below)          |
| architecture lint  | 16 rules, 0 violations                                   |
| lint self-tests    | green, including 2 new workflow-hazard checks            |
| evidence gate      | 7 matrices, 85 alpha.9 rows, every claim resolves        |
| typecheck / format | clean                                                    |
| release gate       | green at `c701a31` (run `31935882150`), tagged alpha.8.1 |

The release gate was also dispatched against this branch's head, `5eda8fb`
(run `31937426583`), and every tier passed — offline on both tier-1 platforms,
container and native each under their `_REQUIRED` variable, and the artifact
packed, installed into a clean prefix and driven.

State that precisely. It means the work recorded above is green at an exact
commit. It does **not** mean the milestone is complete: a green gate proves the
tree is consistent, and §0 is what says whether the milestone's claims are true.
Those are different questions, and conflating them is how alpha.8 ended up with a
tag on a commit its own gate rejects. No tag is cut here.
