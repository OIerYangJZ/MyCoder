# ADR-0014 — Container ExecutionBackend and enforcement levels

**Status:** accepted (`v0.1.0-alpha.5`)
**Extends:** ADR-0007 (one execution backend interface), ADR-0009 (zero runtime
dependencies), ADR-0012 (two workspace roots).
**Supersedes:** nothing. It does replace one _field_: `sandboxStrength` is no
longer asserted by each backend, it is derived from a new `EnforcementDescriptor`.

## Context

Through alpha.4 every backend told the truth and the truth was the same
sentence: **policy-enforced**. The kernel decides what a tool may ask for, and
then a subprocess runs with the user's own rights and can open anything the user
can open. `sandboxStrength: 'policy-enforced'` said so, `/status` printed it, and
the system prompt repeated it. alpha.4's own status document names this as the
largest remaining gap: _isolation remains policy-enforced, same uid, same process
authority, network partly best-effort._

That gap has a specific shape. It is not that the policy engine is weak — the
canary suite shows it refuses the paths it is meant to refuse. It is that policy
only sees what a _tool_ asks for. `Shell` declares the path-like tokens in its
argv, which catches `cat .env`; it cannot catch a program that computes a path at
runtime, and it was never going to. The alpha.4 evidence matrix records that
honestly and the alpha.5 plan sets the goal:

> forbidden host resources are unreachable at the OS/container boundary rather
> than merely rejected by path/string policy.

Two decisions were needed to get there, and the second is the one that took the
most care.

## Decision

### 1. A container backend, behind the existing interface

`ContainerExecutionBackend implements ExecutionBackend`. Not a mode, not a flag
on the local backend, not a wrapper that the tool runtime knows about. The agent
loop, the tool runtime and all six tools are unchanged, and the only code outside
`src/execution/container*.ts` that knows containers exist is the bootstrap that
selects a backend and the `/status` line the backend contributes as strings.

The transport is the `docker` CLI, invoked through `spawn`, per ADR-0009. No
Docker SDK. The kernel owns the four things that matter — argument construction,
plan validation, error mapping, result normalisation — and all four are pure
functions in `container-plan.ts`, which is why the security-relevant behaviour has
unit tests that run with no daemon present.

Execution is **one ephemeral container per exec**, `--rm`. The alternative — a
session-lived container with `docker exec` per command — is faster and wrong for
this milestone: the capability profile changes per tool call, and Docker cannot
change a running container's mounts or network mode. A container whose mounts were
planned for the _previous_ call is a capability leak that looks like an
optimisation.

### 2. Mounts are derived from the capability profile, not from the workspace

The tempting implementation is one line:

```
-v "$WORKSPACE:/workspace:rw"
```

It is wrong in a way that is invisible from outside. Every profile gets the same
mount, so a read-only session, a review skill and a full dev session all hand the
subprocess identical write authority. The container would be real and the
enforcement would be theatre.

So `planContainerMounts(profile, …)` produces:

```
/workspace                     the workspace root, read-only
/workspace/<granted write root>  read-write, one per granted root
/workspace/<protected path>      masked with an empty file or an empty tmpfs
/tmp, /var/tmp                   tmpfs, sized, never shared with the host
```

and nothing else. There is no code path that emits a mount outside the workspace,
which is why "host home absent", "credential directories absent" and "no Docker
socket" are properties of the planner rather than checks bolted on afterwards.

Three consequences are worth stating because they are visible to users:

- **A write granted on the workspace root is refused, not widened.** Making the
  base mount read-write to satisfy it would also make `.git` and every source
  file writable. The plan records it as `unrepresented` instead (§14).
- **`.git` is read-only.** No approved VCS mutation exists in v0.1.
- **Protected paths _inside_ the workspace are masked**, not merely denied: an
  empty read-only file is mounted over `.env`, so the bytes are absent rather
  than policy-refused. `tar cf - . | base64` cannot encode what is not there.

A second boundary, `validateContainerPlan`, re-checks the finished plan before
Docker sees it: no protected source, no host root, no socket, no privileged flag,
no host namespace, every rw mount authorised, every path canonical, network
matching the capability, environment scrubbed, image trusted. Everything it checks
is already impossible by construction. That is the point — the interesting failure
is not "it caught a hand-written plan", it is "the planner acquired a bug and the
bug did not reach the daemon".

### 3. Enforcement is six levels, not one word

This is the decision that shapes what the kernel is allowed to _say_.

A container does not move one dial. It makes the subprocess's filesystem view a
kernel-enforced fact; it leaves the trusted file broker exactly as policy-enforced
as it was; it enforces network _denial_ absolutely while enforcing a host
_allowlist_ not at all; and its strength against the host boundary depends on
whether Docker is a native engine or a VM. Collapsing that into `os-isolated`
requires rounding, and rounding up is precisely what invariant 5 forbids.

```ts
interface EnforcementDescriptor {
  processFilesystem: EnforcementLevel;
  processNetwork: EnforcementLevel;
  processPrivileges: EnforcementLevel;
  environmentIsolation: EnforcementLevel;
  hostFileBroker: EnforcementLevel;
  networkAllowlist: EnforcementLevel;
  platformNotes?: readonly string[];
}
```

with `EnforcementLevel` ordered `none < best-effort < policy-enforced <
container-enforced < os-enforced`. `sandboxStrength` survives as a _derived_
summary — the weakest of the two process-facing dimensions — so a backend cannot
claim a label its enforcement does not support. `os-enforced` is unused in
alpha.5; it exists so that a future namespace/seccomp backend has somewhere honest
to sit and `container-enforced` is not silently the ceiling.

The two entries people get wrong are deliberate:

- `hostFileBroker: 'policy-enforced'` on the container backend. `Read`, `Edit`,
  `Grep`'s fallback scanner and the freshness ledger are _trusted kernel_
  operations against the host filesystem (§28), and containerising them would mean
  re-implementing the edit protocol as `docker exec sed`, which §30 rules out.
  Reporting them as container-enforced would be the exact overclaim this
  descriptor exists to prevent.
- `networkAllowlist: 'best-effort'` even on a container. `--network none` is a
  real boundary; an ordinary bridge network does nothing whatsoever to confine
  _which_ hosts are reachable. Until there is an egress proxy inside the network
  namespace, `hosts = ["registry.npmjs.org"]` is a note in an audit record. The
  approval prompt says so in those words, because that prompt is the last point at
  which a human can decline.

### 4. Platform claims are separated from platform behaviour

`nativeLinux` is computed from the daemon's own report, and the platform note is
generated from it. On a native Linux engine the note says the namespaces are
enforced by the host kernel. On Docker Desktop it says the daemon runs in a VM,
that container execution is validated, and that **native-Linux-equivalent
isolation is not claimed** — even though the same attack suite passes there. A
passing suite is evidence about the suite; it does not erase the platform
distinction (§38).

### 5. No silent fallback, ever

If `--backend container` is requested and the runtime is missing, the daemon is
down, or the image is absent, `createKernel` throws a structured error and the
session does not start. There is no `ok: false` return, no fallback parameter, and
no `--backend auto`. A backend that quietly executed locally would turn a security
decision into a warning nobody reads.

The errors are distinct — `CONTAINER_RUNTIME_NOT_FOUND`,
`CONTAINER_RUNTIME_UNAVAILABLE`, `CONTAINER_IMAGE_NOT_FOUND`,
`CONTAINER_UNSUPPORTED_FEATURE`, `CONTAINER_INVALID_MOUNT`,
`CONTAINER_START_FAILED`, `CONTAINER_RESOURCE_LIMIT`, `CONTAINER_PLAN_REJECTED` —
because the recoveries differ, and a session that cannot tell them apart cannot
tell the user whether to install Docker, start it, or pull an image.

### 6. The image is configuration, never model input

The image comes from user config or the built-in default, its resolved id and
digest are recorded as provenance, and the plan validator refuses any image not on
the trusted list. A project-declared `container.image` is dropped with a warning,
for the same reason a project may not declare a provider endpoint: it would be
choosing the interpreter its own tests run inside.

Pulling is a setup action (`container.pull_if_missing`, user config only), never
an implicit tool-time side effect.

### 7. Hardening flags are not configurable

`--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--rm`, a
non-root `--user`, and the resource bounds are properties of _every_ plan this
kernel produces. There is no config key and no model-reachable path to a plan
without them; `[container] privileged = true` is warned about and ignored. §70's
"Privilege Stop" is that tool or model input could inject a privileged flag, and
the way to make that unreachable is to not have the knob. An architecture lint
rule (`no-container-escape-flags`) keeps the flag names out of the source
entirely, outside the validator that must name what it rejects.

## Consequences

**What gets better.** For the first time the kernel can say that an arbitrary
subprocess _cannot reach_ a host credential, rather than that it _will be
refused_. The §59 attack matrix runs real interpreters against real paths and the
blocker is `ENOENT` from the kernel of the machine. `network: false` becomes a
fact. A read-only subagent's shell fails at the filesystem layer, closing the
last of alpha.4's OS-isolation NOT TESTED rows.

**What gets worse.** Latency: one container start per command, roughly 250–800 ms
on Docker Desktop against ~20 ms locally. Capability: a command can only write
where a capability granted a mount, so build outputs need the configured
`[generated_paths]` and anything else fails visibly rather than silently
succeeding. Surface: the kernel now depends on a daemon it does not control.

**What is explicitly not claimed.** Resistance to Docker or kernel zero-days,
daemon compromise, or a privileged-container escape. VM-level isolation.
Native-Linux-equivalent isolation on macOS or Windows. Host-scoped network
allowlist enforcement. Those are listed as non-claims in the release notes and
each has a matrix row saying why.

**What this leaves for later.** An egress proxy in the container network
namespace would move `networkAllowlist` off `best-effort`; a Linux namespace
backend would make `os-enforced` reachable; a persistent container with capability
re-negotiation would address the latency. None of them is required to make the
claim alpha.5 actually makes, and each would have made this one harder to check.
