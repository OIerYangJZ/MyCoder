# Web access

The agent cannot reach the web until you say which hosts it may reach. There is
no flag, no prompt that opens it and nothing the model can do to widen it: the
list lives in your config file, and when it is empty the `WebFetch` tool is not
registered at all.

## Turning it on

In `~/.config/mycoder/config.toml`:

```toml
[egress]
web = ["docs.python.org", "developer.mozilla.org", "api.github.com"]
```

Hosts are exact names, matched after normalisation (`Docs.Python.Org.` and
`docs.python.org` are the same entry). A leading `*.` wildcard is **not**
supported — see `src/security/egress/host.ts` for why a wildcard in a policy that
is compared against a connected address is a bypass rather than a convenience.

A project's `.mycoder/config.toml` can only _intersect_ this list. A repository
you clone cannot add a destination, only remove one.

## What happens on a call

1. The host must be on the list above, or the call is refused with no prompt.
2. The connection is an ordinary `network.connect` capability, so it asks for
   approval under `workspace-dev` and is denied outright under `read-only` and
   `review`. Approving is per host, and remembering it (`allow for this session`)
   remembers that host, not "the web".
3. The host is resolved and every address it answers with must be public. An
   allowlisted name that points at `127.0.0.1`, `10.0.0.5` or `169.254.169.254`
   is refused, and the refusal names the scope. A host that is loopback by name
   (`localhost`) is exempt — you put it there on purpose.
4. The request goes through the egress gate: TLS required, body scanned, audit
   record written with the host, the byte count and the response status — never
   the content.

If every fetch fails with "the host resolves to a benchmarking address", your
resolver is mapping public names into `198.18.0.0/15` — common behind a VPN or
some Docker Desktop setups. Check with `node -e "require('dns').lookup('example.com',console.log)"`,
and if that is what is happening:

```toml
[egress]
allow_benchmark_range = true
```

That permits **only** that range. Loopback and metadata addresses stay refused.

## What the tool will not do

- **Trust a name over an address.** See step 3 above. The check is best-effort:
  `fetch` resolves again when it connects, so a resolver that answers differently
  twice is not something this can stop — it closes the accidental case, not a
  determined one.
- **Follow redirects.** A 3xx comes back as an error naming the destination. If
  you want it fetched, the model has to ask for it by name and it has to be a
  configured host.
- **Send anything.** `GET` only, no request body, no cookies, no custom headers.
- **Run JavaScript.** A single-page app returns its empty shell, and the result
  says so rather than pretending the page was empty.
- **Return binary.** Only text, JSON, XML and HTML; HTML is reduced to text with
  scripts and styles removed.

## The part that is not a technical control

Fetched content lands in the same context window as your instructions, and the
page's author chose what is in it. The kernel caps it, scans it for credentials,
strips the parts that are not prose, and wraps it in a boundary that tells the
model the content is data — but "an instruction inside fetched text" is a live
prompt-injection surface, and the honest position is that the labelling reduces
it rather than removing it. Treat an agent that has just read a URL the way you
would treat one that has just read a PR from a stranger.

See `docs/adr/ADR-0017-web-reads-through-the-egress-gate.md` for the reasoning,
and `tests/security/web-fetch.test.ts` for what is actually enforced.
