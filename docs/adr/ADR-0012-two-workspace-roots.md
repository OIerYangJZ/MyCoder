# ADR-0012 — The tool plane's root is the backend's root

**Status:** accepted (`v0.1.0-alpha.3`)
**Extends:** ADR-0007 (one ExecutionBackend interface). **Fixes:** the `FAIL` row
recorded in `docs/alpha3-evidence-matrix.md` §2.

## Context

`createKernel` computed one workspace root, from the local working directory, and
gave it to everything: the policy engine, the permission profile, the tool
runtime, the repository plane, the mutation detector, the session metadata. The
SSH backend jailed against a _different_ root — the remote `workspace` from
`remotes.toml`.

Measured on a real VM:

```text
LOCAL  workspaceRoot         : /Users/…/MyCoder/kernel
REMOTE backend workspaceRoot : /home/…/Desktop/MyCoder
policy engine root           : /Users/…/MyCoder/kernel   <- local
```

Those two path sets are disjoint, so **no path could satisfy both layers**. A
relative `hello.py` resolved against the local root, passed the local policy
check, and was refused by `SshFileSystem.jail()`. An absolute remote path failed
the other way round. With DeepSeek driving, every `Edit` and `Shell` returned
`PATH_OUTSIDE_WORKSPACE` for 16 model requests until `LOOP_BUDGET_EXCEEDED`.

`--remote` could connect, report status and start a session. It could not read,
write or run anything.

This contradicts spec §19.1, whose diagram places fs operations, grep,
shell/test and git in the _remote_ workspace, with only the kernel and the model
local.

**Why 100+ tests missed it.** The §14–§21 SSH matrix drives
`SshExecutionBackend` **directly**, with remote paths it constructs itself. The
jail is satisfied and the policy engine is never consulted. Nothing exercised
`CLI → ToolRuntime → policy → SSH`. That was already recorded as a `NOT TESTED`
row — and it was concealing a total functional break rather than a rough edge,
which is the strongest argument in this milestone for closing such rows rather
than living with them.

## Decision

**There are two roots, named separately, and the tool plane's one is derived
from the backend rather than recomputed.**

### `projectRoot` — local, always

The directory the session was started from. What lives there:

- `.mycoder/config.toml`, `permissions.toml`, `hooks.toml`
- skills and agents
- the anchor for the session store

It is always local, for a reason that is not a preference: **the configuration
that names a remote cannot be read through that remote.** `remotes.toml` and the
project config have to be readable before a backend exists.

### `workspaceRoot` — whatever the backend says

```ts
const workspaceRoot = backend.environment.workspaceRoot;
```

`LocalExecutionBackend` reports the project root; `SshExecutionBackend` reports
the remote workspace. Deriving rather than recomputing is the whole point: the
two layers that independently decide whether a path is allowed now read the same
value, so they agree **by construction**. There is no arithmetic left to get
wrong.

This forces one ordering change: the backend must be constructed before the
policy engine, the permission profile and the tool runtime. It already was.

### Which collaborator gets which

| Collaborator                            | Root            | Why                                                  |
| --------------------------------------- | --------------- | ---------------------------------------------------- |
| `loadConfig`                            | `projectRoot`   | config names the remote; cannot come through it      |
| `loadHooks`                             | `projectRoot`   | `hooks.toml` is a project file                       |
| `discoverSkills` / `discoverAgents`     | `projectRoot`   | project files                                        |
| credential "inside the workspace" check | `projectRoot`   | the `git add` risk is local                          |
| reference-tree resolution               | `projectRoot`   | reference trees are local paths                      |
| session store                           | `projectRoot`   | the event log is local                               |
| `PolicyEngine`                          | `workspaceRoot` | containment must match the jail                      |
| permission profile read/write roots     | `workspaceRoot` | same                                                 |
| `ToolRuntime` (path resolution)         | `workspaceRoot` | same                                                 |
| `RepositoryPlane`                       | `workspaceRoot` | the code being worked on                             |
| `MutationDetector`                      | `workspaceRoot` | the tree that can change                             |
| `agentTmpDir`                           | `workspaceRoot` | a local temp dir is unreachable to a remote executor |
| `HookRunner` cwd                        | `workspaceRoot` | hooks execute through the backend                    |
| git facts probe                         | `workspaceRoot` | the repository is remote                             |
| `workspaceIdentity` (resume)            | `workspaceRoot` | resume must notice the remote changing               |

Note the split inside hooks: the _definition_ is read locally, the _command_
runs against the workspace root. Those are genuinely different questions and
conflating them is the same mistake at smaller scale.

### `Kernel` gains `projectRoot`

`Kernel.workspaceRoot` keeps its name and changes meaning — it is now the tool
plane's root, which for a local backend is unchanged. `Kernel.projectRoot` is
new. That is a public-interface change, hence this ADR (AGENTS.md rule 4).

## Consequences

**`--remote` works.** Verified end to end: DeepSeek, over SSH, writing and
running a file on a real VM.

**Resume across backends is now correctly refused.** `workspaceIdentity` follows
the tool-plane root, so resuming a remote session locally is an identity mismatch
rather than a session that silently operates on the wrong tree.

**A limitation this makes explicit rather than introduces:** with a remote
backend, locally-configured reference trees are unreachable to the tool plane.
They resolve against `projectRoot` and the executor is remote. Previously this
was hidden behind the fact that nothing worked at all. Reference trees plus a
remote backend is not a supported combination in v0.1.

**Still open, and behind this fix rather than fixed by it:** remote resume,
remote hook execution, and replay validity after remote operations. All three
need a full remote session driven through its lifecycle; ADR-0012 only makes such
a session possible.

## The test that would have caught it

`tests/integration/backend-roots.test.ts` asserts the invariant directly:

```ts
assert.equal(kernel.policy.workspaceRoot, kernel.backend.environment.workspaceRoot);
```

It needs no SSH server, because the property is agreement between two in-process
objects rather than transport behaviour. It also asserts the _mechanism_ against
the source — that `workspaceRoot` is read from the backend and that the
local-only collaborators are handed `projectRoot` — because an implementation
that recomputed the root could pass every behavioural assertion with a local
backend and still break `--remote` exactly as before.

## Alternatives considered

**Translate paths at the backend boundary.** Map `projectRoot`-relative paths
onto the remote workspace inside `SshExecutionBackend`. Rejected: the policy
engine would still be reasoning about local paths, so `ProtectedPaths` would
check the wrong tree — a remote `~/.ssh` would be judged against local rules —
and every audit record would name a path that does not exist on the machine the
work happened on.

**Require the remote workspace to mirror the local path.** Rejected as a
constraint that cannot be met: the local checkout and the remote workspace are on
different machines with different layouts, which is the point of a remote.

**One root, switched by a flag.** That is what existed. The failure mode is that
the switch is applied in some places and not others, which is precisely what
happened.
