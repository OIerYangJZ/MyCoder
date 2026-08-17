# ADR-0028 — The workspace may not contain the configuration directory

**Status:** accepted · **Date:** 2026-08-17 · **Milestone:** v0.1.0-alpha.12 (post-tag)

## Context

Running `mycoder` in a home directory made the home directory the workspace. What
happened next depended on something unrelated: **how the credential was supplied.**

```text
api_key_file   refused to start — "The credential file … is inside the workspace.
               A credential there is one `git add` from being committed … Move it
               outside the repository."
api_key_env    started normally. permission profile: workspace-dev. No warning.
```

Same directory, same exposure, opposite outcome. The refusal came from the
credential-file check (`checkCredentialFile`, alpha.3 §6), which asks whether the
_credential_ is inside the workspace. It was never a decision about the workspace;
it stopped some people by accident and let the rest through.

Two things were wrong with that, and the second is worse than the first.

**The remedy was actively misleading.** The credential sitting in
`~/.config/mycoder/secrets/` is in the place every document in this repository tells
you to put it. "Move it outside the repository" points at the one thing that was
already right, and a reader who followed it would move a correctly-placed key
somewhere worse. `mycoder doctor` repeated the same sentence, so the documented
escape hatch did not help either.

**The exposure it accidentally prevented is not mainly about the credential.** A
session whose workspace is `$HOME` has `workspace-dev` write access to everything
under it — dotfiles, ssh config, other repositories, and the kernel's own
configuration, which decides where prompts are sent. The credential file is a small
part of that, and it is the part already covered by another mechanism: once
configured, its canonical path is hard-denied to Read, Grep, Glob, Shell, Hooks,
Skills and Subagents, and no profile or approval can lift that.

Found by installing the tag's artifact on a Linux machine and running `mycoder` in
the home directory, which is the first thing anybody does.

## Decision

**A workspace that contains the user configuration directory is refused, before
anything is built, whatever the credential source.**

```text
error code   WORKSPACE_CONTAINS_CONFIG
exit code    2 (USAGE) — the command was run in the wrong directory
doctor       a `workspace` finding, `blocked`, with the same remedy
remedy       cd <project> && mycoder    |    mycoder --cwd <project>
```

The test is **containment of the config directory**, not "is this the home
directory". That catches `$HOME`, `/`, and a `--cwd` that resolved higher than
intended, and it does not fire for the ordinary case of a project that lives under
`$HOME` — which is nearly every project.

`checkCredentialFile` keeps its own refusal, and its message now distinguishes the
two situations it can be in (`workspace-contains-config` versus
`inside-workspace`). Defence in depth: the startup check is what a user meets, and
the credential check still holds for any caller that reaches it directly —
`setup-credential` does.

## Consequences

**This is a tightening, and it costs something.** `mycoder` can no longer be run
with the home directory as the workspace at all — including to edit dotfiles, which
is a legitimate thing somebody might want. The judgement is that an agent pointed at
an entire home directory is a bad default that nobody chose deliberately, and that
`--cwd` is a cheap way to say what you meant. If the dotfiles case ever needs
answering, it should be answered explicitly — a named opt-in, disclosed at startup —
rather than by removing this refusal.

**No boundary is relaxed and no capability is added.** ADR-0027 §5's commitment
holds: alpha.12 adds no capability, and a refusal that now applies to more people is
not one. `WORKSPACE_CONTAINS_CONFIG` is a new error _code_, which `docs/cli-contract.md`
permits within `mycoder.v1` ("may change: new `code` values"); no exit code changes
meaning.

**A wrapper script can now get exit 2 where it previously got a session.** Only if
it ran in a directory containing the config directory, which it should not have been
doing. `2` rather than `3` or `4` is deliberate: nothing is wrong with the
configuration and no boundary refused a request — the invocation was in the wrong
place, and retrying it unchanged will fail again.

**`--print-config` and `--version` still work anywhere**, because they build no
kernel and start no session. `doctor` reports the block rather than refusing to run:
its whole job is to explain why things will not start.

## Alternatives considered

**Allow it, with a loud startup disclosure.** Rejected. It reads as the friendly
choice, but the disclosure would be one more line in a startup banner nobody rereads,
and the thing being disclosed is "this session may write anywhere under your home
directory". This project's own rule applies: a convenience that cannot be provided
without weakening a boundary is a downgrade with better marketing.

**Keep the credential-file refusal as the only guard, and fix its wording.** That was
the first attempt, and it is what exposed the real problem: it leaves `api_key_env`
users unprotected, and it explains the workspace's mistake in terms of the
credential. The wording fix is kept; it is not the fix.

**Refuse only when the workspace _is_ the home directory.** Narrower and easier to
explain, and it misses `/`, `/Users`, and a mistyped `--cwd` one level too high —
each of which contains the config directory and each of which is the same hazard.
