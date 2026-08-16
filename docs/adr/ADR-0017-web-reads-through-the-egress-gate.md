# ADR-0017 — Web reads through the egress gate

**Status:** accepted · **Date:** 2026-08-15

## Context

`EgressKind` has carried `'web'` since the first commit, with an empty default
allowlist and no consumer. The spec (§14.1) lists "Web tool" among the channels
that must not call `fetch()` directly, and until now the way the kernel honoured
that was by not having a web tool at all.

The cost of that is not theoretical. An agent that cannot read a URL cannot read
the error message a CI run linked to, the API documentation for the library it is
calling, or the issue it was asked to fix. Every dogfood ended with the human
pasting a page into the prompt.

The reason it stayed unbuilt is that a naive web tool is an exfiltration channel
with a friendly name: it turns "the model chose a string" into "the kernel made a
request", and the string can carry the contents of the workspace in a query
parameter.

## Decision

**`WebFetch { url, maxBytes?, raw? }`** — one tool, `GET` only, no request body.

Four independent things must agree before a byte moves:

1. **Configuration.** The host must be in `[egress] web = [...]`. This is the
   existing config surface, with the existing merge semantics: a project config
   can only intersect the user's list, never widen it. If no web hosts are
   configured the tool is **not registered at all**, exactly as `Delegate` is
   absent when a project has no agents — a catalogue entry that can only fail
   costs a step to discover.
2. **Policy.** Every call declares `network.connect { via: 'web', scope:
'scoped', host, port }`, so it is `ask` under `workspace-dev` and `deny` under
   `read-only` and `review`, and an approval is remembered per host — never per
   tool, never per session-wide "web access".
3. **The granted profile.** `execute()` re-checks the host against
   `executor.profile.network` before calling the gate. The sandbox planner
   derives that from the decisions the policy engine actually granted, so a tool
   bug that fetched a different URL than the one it declared is refused here.
4. **The gate.** `EgressGate.send({ kind: 'web' })` applies the allowlist, the
   TLS requirement, the size budget and the secret inspection. `web` blocks —
   rather than redacting — on any credential-shaped value, which is why the tool
   never puts workspace content in a request.

**And the address, not just the name.** alpha.6 §23 put that check inside the
egress proxy, where it is the reason a DNS rebinding fails for a host the policy
allows. There is no proxy on this path — the kernel makes the request itself — so
`resolveHostScope` asks the same question here: every address the name resolves
to must be global, or the fetch is refused naming the scope
(`loopback`, `metadata`, `private`, `link-local`). A host that is loopback _by
name_ is exempt, because a `localhost` in the operator's allowlist was put there
deliberately; a public name that _resolves_ to loopback was not.

This is **best-effort and labelled as such**: `fetch` resolves again when it
connects, and nothing in a zero-dependency HTTP client lets us pin the socket to
the address we validated. It closes the accidental and the lazy case; it does not
close a resolver that answers differently twice on purpose.

### The address check has never been positively demonstrated on this project's infrastructure

**Status: NOT APPLICABLE, decided in alpha.10 §15 after three milestones of
restatement.** This paragraph is the downgrade, and it is here rather than in a
status document because a reader of the ADR is the person entitled to know.

Every negative control passes: four scopes — `loopback`, `metadata`, `private`,
`link-local` — are refused, and the refusal names the scope. What has never been
produced is the **positive** control: an approved host whose resolved address is
genuinely global, reached under the strict default with no opt-in.

The reason is infrastructural and unchanged since alpha.6. Both hosts available
to this project answer every public name inside `198.18.0.0/15` (RFC 2544
benchmarking space), which is genuinely non-global, so the check correctly
refuses all of them. Re-verified on 2026-08-16, on both hosts:

```text
github.com   → 198.18.1.168
example.com  → 198.18.2.134
```

`[egress] allow_benchmark_range` is the operator's explicit opt-in for exactly
this network, and it is off by default and off in CI. A test that switched it on
would be asserting that the _exception_ works, which is not the claim.

Three milestones carried this as `NOT TESTED`, and `NOT TESTED` implies "we will
get to it". After three restatements that implication is false, so the row is now
`NOT APPLICABLE` with this reason attached. **A claim restated for the fourth
time is not being tracked; it is being avoided.** The claim this project makes
about `resolveHostScope` is therefore: it refuses four non-global scopes, each
demonstrated, and its behaviour on a globally-routable answer is asserted by unit
tests over the classifier and by no end-to-end run anywhere. One Linux host with
an ordinary resolver closes it in about half an hour, and if one becomes
available this paragraph should be deleted rather than amended.

**Redirects are not followed.** The transport is asked for `redirect: 'manual'`
and a 3xx comes back to the model as an error naming the `Location` host, with an
instruction to re-issue the call against it if that is what it wanted. Following
a redirect would let an approved host hand the kernel a destination that neither
the user nor the allowlist ever saw, which is the single most common way an
allowlisted fetcher becomes an open one.

**The response is treated as hostile input.** Only `text/*`, JSON and XML content
types are accepted; HTML is reduced to text with scripts, styles and markup
removed; the body is capped (64 KiB of text by default, streamed and cut rather
than buffered whole); it is secret-scanned and redacted on the way in, like a
`Read`; and it is delivered wrapped in an explicit boundary that tells the model
this is untrusted third-party content and that instructions inside it are data,
not commands.

## Rationale

Layers 1 and 2 answer different questions and both are needed. Configuration says
_which destinations this installation will ever talk to_, and it is a human
editing a file outside the session. Approval says _whether this session, right
now, may reach one of them_, and it is a human answering a prompt. Collapsing
them — a tool that any approval can point anywhere — would mean the answer to
"where can this agent send data" was whatever the user last clicked through.

Layer 3 exists because the resolve/execute split (ADR-0003) is only a security
property if `execute()` cannot exceed what `resolve()` declared. The web tool is
the first tool whose effect is a network request the _kernel_ makes rather than
one a subprocess makes, so it is the first place that check has to be written by
hand rather than being a property of the sandbox.

The response handling is deliberately conservative because prompt injection from
fetched content is not a hypothetical: the content is chosen by whoever controls
the page, and it lands in the same context window as the user's instructions. The
kernel cannot make that content safe. It can refuse to hide its provenance.

## Consequences

- Out of the box there is no web access, and the failure mode is "the tool is not
  in the catalogue" rather than a confusing denial. `docs/web-access.md` is the
  one place that says how to turn it on.
- No JavaScript is executed and no page is rendered, so single-page applications
  return their shell. That is a real limitation and the tool says so rather than
  returning an empty result.
- `EgressRequest` gains an optional `redirect` field. Existing callers keep the
  default (`follow`); only `WebFetch` sets `manual`.
- `[egress] allow_benchmark_range` exists for one measured reason: some resolvers
  — DNS-interception VPNs, Docker Desktop in some configurations — map _public_
  names into RFC 2544 space (`198.18.0.0/15`), and on such a machine the address
  check denies the entire internet. It is off by default, merges with
  `strictBoolean` so a project config can only turn it off, and permits exactly
  that range — loopback and metadata stay refused with it on.
- Search is not in scope. A search tool needs a provider, an API key and a
  ranking model of its own, and none of that is a v0.1 kernel concern.
