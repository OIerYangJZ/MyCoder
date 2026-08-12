# ADR-0011 — Persistent provider credentials via `api_key_file`

**Status:** accepted (`v0.1.0-alpha.3`)
**Supersedes:** nothing. **Extends:** ADR-0005 (Secret Broker and Egress Gate).

## Context

Through alpha.2 the only way to give the kernel a provider credential was an
environment variable named by `api_key_env`. That works, and it is safe, but it
means every terminal starts with:

```bash
export DEEPSEEK_API_KEY=...
```

This was the last thing standing between the runtime and ordinary daily use.
alpha.3 §4.1 names it as the main remaining operational blocker, and it is not a
cosmetic one: a tool people have to prepare before they can use it is a tool
they use less, and the workaround people reach for — putting the key in a shell
rc file, or in a checked-in `.env` — is worse than either supported option.

The `SecretBroker` already had a `file` source (`{ kind: 'file', path }`). What
was missing was a way to _configure_ it.

## Decision

### 1. `api_key_file` in the provider endpoint block

```toml
[model.provider.deepseek]
protocol = "openai-chat"
base_url = "https://api.deepseek.com"
api_key_file = "~/.config/mycoder/secrets/deepseek.key"
```

User configuration only, like `base_url` and `api_key_env` before it. A project
file that could name a credential path could name one it also ships.

A relative path anchors to the **user config directory**, not the workspace.
Anchoring to the workspace would make the natural-looking
`api_key_file = "secrets/deepseek.key"` resolve inside the repository and then
be rejected for being there, which is a confusing way to learn the rule.

### 2. Precedence

```
explicit CLI/session secret override
  > api_key_file
  > api_key_env
  > no credential
```

`file` beats `env` because it is the source with a security property attached:
it is permission-checked and registered as a protected path, and if both are
configured the one carrying guarantees should be the one in force. The loser is
reported as a warning rather than silently shadowed.

**A rejected file does not fall back to the environment.** If `api_key_file` is
configured but insecure, the provider ends up with _no_ credential even when
`api_key_env` is set and would have worked. Falling back would mean the run
succeeds and the user never learns their key file is world-readable — the
failure has to attach to the thing that is wrong.

### 3. Validation is not optional, and the kernel never repairs the file

A credential file must be a regular file, not a symlink, owned by the current
user, mode `0600` or stricter, outside the workspace and outside every reference
tree. Anything else is `CREDENTIAL_FILE_INSECURE`.

Two details that are easy to get backwards:

- The **symlink check runs before canonicalisation**. §6 asks for both
  "canonicalized before validation" and "not symlink", and those pull against
  each other: canonicalising first follows the link, so the validation would
  describe the target while the link is what gets read next time. The path is
  therefore resolved lexically first (absolute, `~` expanded, `..` collapsed,
  final component untouched), checked, and only then fully canonicalised for
  registration.
- The kernel does **not** `chmod` the file. Repairing it would make the warning
  vanish on the second run, which is exactly when someone would stop believing
  it mattered. It is also an unrequested modification of a file outside the
  workspace.

### 4. Configuring a credential path _is_ protecting it

The validated canonical path is passed into `ProtectedPaths` at construction.
There is no ordering in which a credential path is configured but not yet
protected, because the object that enforces the denial cannot be built without
the list.

The path is hard-denied for read-to-model, for kernel-internal reads (so no
content hash reaches the event log), and for writes (an agent that could
overwrite the file could swap in a key it controls, or empty it, without ever
reading the old value).

A path that **failed** validation is protected too. A path the user pointed at a
credential is a path the model has no business reading, whether or not the
kernel could use it.

### 5. An inline `api_key` is refused, loudly

Config files are what people paste into issues and check into dotfile
repositories. An inline credential is warned about and ignored rather than
honoured, so it cannot look like it took effect.

## Consequences

**Good.** A developer configures the key once. `/status` reports the source and
whether a credential was found, never the value and never the path. The
`SecretBroker` interface is unchanged, so a future Keychain or Secret Service
source replaces the _source_ without touching the broker, the lease model, or
anything downstream.

**Costs.** One more thing to get wrong at configuration time, mitigated by the
error naming the specific defect and the remedy (`chmod 600 <path>`). And a real
gap: **Windows has no POSIX mode bits**, so the permission check is skipped
there and `mode` comes back undefined. That is recorded in `docs/threat-model.md`
rather than papered over with a check that always passes.

**What this is not.** `api_key_file` + `0600` is local credential persistence,
not a hardware-backed vault. See `docs/threat-model.md` for what it does and does
not defend against.

## Alternatives considered

**Keychain / Secret Service / Credential Manager first.** Three OS integrations,
each with its own failure modes, none of which removes the need for a file-based
source on headless machines and in CI. alpha.3 §3.3 lists all three as
non-goals. The broker interface makes them additive later.

**`api_key` inline in config.** Rejected; see §5.

**Environment-first precedence.** Would mean a correctly configured, permission-
checked file silently loses to a stale variable left in a shell — with no
warning, because the environment is where the value came from before.
