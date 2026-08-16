# A live model on the native Linux backend

**alpha.11 CLOSURE C · closes `docs/open-evidence.md` A3**
**Date:** 2026-08-16 · **Host:** `linux-vm`, Ubuntu 26.04 aarch64, kernel
`7.0.0-29-generic`, Node 22.20.0
**Model:** `deepseek-chat` via `https://api.deepseek.com`, one turn, non-interactive

The strongest enforcement claim this project makes lives on the native Linux
backend — Landlock and seccomp, no container runtime, no Docker daemon to trust.
Until today it had never run a real model. alpha.8 ran a packaged install on this
backend and alpha.7 built it, but both used the fake model, and the row said so:

> Partially closed: a packaged install ran a real session on the native backend
> (§6), but with the fake model. Placing a provider credential on that host is
> the user's decision, not the agent's.

The decision was made. This is the run.

---

## 1. What was set up, and by which route

The credential was placed **through the product's own path**, not by copying a
file, which is worth stating because it exercised the surface a new user meets:

```text
mycoder setup-credential secrets/deepseek.key      # key on stdin
→ Wrote /home/yangjinsey/.config/mycoder/secrets/deepseek.key (mode 0600).
  The kernel accepts it. Point a provider at it with:
      api_key_file = "secrets/deepseek.key"
```

The launcher was built on the host from source, and verifies:

```text
verdict    : ok
source     : native/mycoder-sandbox.c        sha256 0b04ec2b8a9d
binary     : build/mycoder-sandbox           sha256 4ef520fa12a8
compiler   : cc -O2 -Wall -Wextra -Werror -std=c11 -D_FORTIFY_SOURCE=2
             -fstack-protector-strong -fPIE -pie -Wl,-z,relro,-z,now
```

`mycoder doctor`, run from the dogfood workspace, reported `provider: model
"deepseek"` and `backend/linux-native: launcher verified`.

## 2. The enforcement the session actually ran under

Copied from the session's own `/status`, not from a description of it. This is
the part that makes the run worth having: the same words the backend has been
claiming since alpha.7, now printed by a session that had a real model in it.

```text
isolation    : os-isolated — network from Shell is enforced
               process filesystem: os-enforced
               process network (default deny): os-enforced
               process network (host allowlist): none
               process privileges: os-enforced
               environment isolation: policy-enforced
               trusted file broker: policy-enforced
platform     : Landlock ABI 8 with seccomp and no_new_privs; no container
               runtime is involved.
platform     : Network denial covers TCP. Landlock has no UDP or raw-socket
               rules, so "no network" here means "no TCP" — the container
               backend is the one that can deny a network namespace outright.
platform     : A host-scoped egress allowlist is not supported and is refused
               rather than approximated.
credentials  : deepseek: credential source: file · credential configured: yes
```

`host allowlist: none` and "refused rather than approximated" are the two lines
that matter. The backend does not round its own capability up when a real model
is driving it, which is the property ADR-0018 exists to protect.

## 3. The task, and what the model did with it

An ordinary task in a workspace with two files, phrased as a user would phrase
it rather than as a fixture:

> parsePort in src/parse.ts accepts anything Number() accepts, including "",
> "99999" and "1e3". Make it return -1 for anything that is not an integer in
> 1..65535. Then update README.md to say so.

Before:

```ts
export function parsePort(input: string): number {
  const n = Number(input);
  return n;
}
```

After — read back off the host, not from the model's summary:

```ts
export function parsePort(input: string): number {
  if (!/^\d+$/.test(input)) return -1;
  const n = Number(input);
  if (n < 1 || n > 65535) return -1;
  return n;
}
```

`README.md` gained the sentence describing the new contract. Both edits landed
through the ordinary read-receipt-edit path under Landlock.

## 4. Two observations, neither a defect

**The model wanted a shell and did not get one, and said so.** Its closing
message:

> I attempted to run an automated verification but the shell was denied
> (non-interactive session). The logic was validated by tracing each case.

That is correct behaviour — `--non-interactive` means there is nobody to answer
an approval prompt, so a call that needs one is denied rather than auto-approved
— and the model reported the limitation instead of claiming it had verified
something it had not. Recorded here because "the agent said it tested it and did
not" is the failure this project would otherwise have to go looking for.

**`setup-credential` refuses to create its own directory**, and names the
remedy:

```text
/home/yangjinsey/.config/mycoder/secrets does not exist.

    mkdir -p /home/yangjinsey/.config/mycoder/secrets
```

An unremarkable message that happens to be the good version of the affordance
`docs/alpha10-second-operator.md` P1 predicts a stranger will struggle with. It
is **not** evidence for P1 either way: the person who hit it wrote the product.

## 5. What this does and does not close

**Closes A3.** A real model ran a real task on the native Linux backend, on a
host that is not the author's Mac, with a credential placed on it, and the
enforcement descriptor printed under those conditions is the one the project has
been claiming.

**Does not close A7** — the clean-resolver non-claim. `linux-vm` shares the same
resolver that maps public hostnames into `198.18.0.0/15`, re-verified again
today. It remains `NOT APPLICABLE` for the reason in ADR-0017, and this host is
not the machine that would change that.

**Does not close A2, A4 or A6.** Hostile-network injection needs root on this
host, the OpenAI account still has no credit, and no Windows machine exists.
They are counted in `docs/open-evidence.md` and named there rather than dropped.

## 6. Afterwards

The credential was **removed from `linux-vm`** once the run completed. The claim
this document establishes is that the dogfood happened, not that a key lives on
that host; leaving a working API key on a second machine to make a matrix row
easier to re-run later is a cost with no evidentiary benefit. §1 records exactly
how to place it again.

## Model provenance

`deepseek-chat`, one turn, one task, N=1. This is a **dogfood**, not a
measurement: there is no control arm, no second model and no repetition, and
nothing in it should be compared with the two-arm experiments. What it
establishes is that the path works end to end with a real model on this backend,
which is a fact about the kernel rather than about the model.
