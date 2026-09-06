# Releasing

What has to be true before anything is published, in the order it happens.

## The name

The npm package is **`mycoder-cli`**. The command it installs is **`mycoder`**.

`mycoder` on npm belongs to an unrelated project (`drivecore/mycoder`), and taking
a name someone else already ships under is not something a package whose thesis is
honest claims gets to do. The two are decoupled by design anyway: `src/app.ts` owns
the binary name, the config directory and the environment prefix, and spec §15 says
rebranding must not reach the protocol — that only stays true if there is one place
to rebrand, which there is.

## What publishing needs, once

**There is no npm token.** Publishing uses npm trusted publishing: the registry is
told, once, which workflow in which repository may publish `mycoder-cli`, and the
job exchanges the GitHub OIDC token for a short-lived credential. Nothing long-lived
is stored, so there is nothing to rotate, nothing to leak and nothing to expire.

Configured on npmjs.com, on the package's own settings page, and it cannot be set
from here:

| Field        | Value          |
| ------------ | -------------- |
| Publisher    | GitHub Actions |
| Organization | `OIerYangJZ`   |
| Repository   | `MyCoder`      |
| Workflow     | `release.yml`  |
| Environment  | `release`      |

The environment name must match the `environment:` on the `publish` job, or the
exchange is refused — that is the point of naming it.

`GITHUB_TOKEN` is provided by Actions. The `publish` job asks for `contents: write`
to create the GitHub release and `id-token: write` for both the credential exchange
and provenance.

### Why it is not a token

`v0.1.0-alpha.13` was published with one, and it took six attempts:

1. the token was pasted into the secret's **name** rather than its value — and a
   secret name is not secret, so it had to be treated as leaked and revoked;
2. then `EOTP`, because the account required a one-time password for writes and no
   CI job can produce one;
3. then `EOTP` again with a fresh token, because regenerating does not change that;
4. and finally a granular token with **bypass 2FA** ticked.

Every one of those failure modes is a property of holding a long-lived credential.
Trusted publishing has none of them, which is why the token was deleted rather than
kept as a fallback: a fallback credential is a credential.

`v0.1.0-alpha.14` published on the first attempt with no secret in the repository
at all — recorded because the registry exposes nothing about its own
trusted-publisher configuration, so a publish is the only thing that can check one,
and this is the publish that did.

### The first publish

Trusted publishing is configured **on a package**, so a name that has never been
published has no settings page to configure. `mycoder-cli@0.1.0-alpha.13` was
published with a token, which is what makes the trusted publisher configurable at
all. Every release after it uses no token.

## Cutting a release, from a checkout

```sh
# 1. the version, in the one place it lives. `pnpm mirrors` refuses if these drift.
#    src/app.ts APP_VERSION and package.json "version" must both say it.
pnpm test && pnpm mirrors && pnpm evidence && pnpm package:check
pnpm release:pack            # builds dist/, packs, prints the sha256 and the commit
pnpm release:formula         # rewrites Formula/mycoder.rb from that exact tarball
git commit -am "Release vX.Y.Z" && git push
git tag vX.Y.Z && git push origin vX.Y.Z
```

The tag is what starts `.github/workflows/release.yml`. It re-runs every tier **at
that exact commit** — offline suite on both tier-1 platforms, container enforcement
on native Linux Docker, the native Landlock/seccomp tier — refuses if any of them
merely _skipped_, packs the artifact, installs it into a clean prefix on a machine
with no checkout, and drives `doctor` through the unconfigured path to check it
exits `3` and names the file to create.

Only then does `publish` run, and only for a tag. It:

1. downloads **the tarball the gate installed and ran** rather than packing a new
   one, so the published bytes are the tested bytes;
2. refuses if the tag does not name the version in `package.json`;
3. `npm publish <tarball> --provenance --tag <alpha|beta|rc|latest>`, chosen from the
   version's own suffix. `npm publish` sets `latest` by default whatever the version
   says, so publishing a prerelease without this hands an alpha to anyone who types
   the package name. The signature binds those bytes to this workflow, this commit
   and this repository;

   > **This does not work on the first publish, and cannot.** npm pins `latest` to
   > the first version a package ever publishes regardless of `--tag`, and provides
   > no way to remove a `latest` tag afterwards — only to move it. `0.1.0-alpha.13`
   > is therefore `latest` as well as `alpha` until a stable release moves it. The
   > flag is still right for every subsequent publish, which is why it stays.

4. creates the GitHub release with the same tarball attached;
5. prints the two lines the Homebrew tap needs.

`workflow_dispatch` runs everything except `publish`, which is the point: a release
can be rehearsed against a commit **before** the tag exists, because a tag is the one
thing in this repository that must never move.

## Homebrew

`Formula/mycoder.rb` lives here rather than only in a tap. A tap has to be its own
repository named `homebrew-<something>`, and the formula in it would be a copy of a
version number that lives here — one more thing that can go stale with no way to
notice. So this file is the source:

- `pnpm release:formula` rewrites its `url` and `sha256` from the tarball that was
  actually packed. It reads the file on disk rather than `build-info.json`, because
  the point is the hash of the bytes that will be uploaded.
- `pnpm mirrors` refuses if the formula's version has drifted from `package.json`.
  Homebrew derives the version from the url, so a stale url installs the previous
  release under the new tag's name — with a checksum that validates, because it
  belongs to the tarball the stale url points at. Nothing about that looks like a
  failure, which is why it is a gate.
- The committed `sha256` is a placeholder of zeros. The artifact embeds the commit it
  was built from, so a committed hash is stale by construction; the mirror checks the
  version and says so in as many words.

The `url` is the npm registry tarball rather than a GitHub source archive, because it
is byte-identical to what the release gate installed and ran — `npm publish <tarball>`
uploads the file it is given rather than re-packing one.

### Updating the tap, from a checkout

```sh
git clone git@github.com:OIerYangJZ/homebrew-mycoder.git
cp Formula/mycoder.rb homebrew-mycoder/Formula/
# then fill in the sha256 the publish job printed — the tap carries the real one,
# this repository carries the placeholder, and the reason is a few lines above.
cd homebrew-mycoder && git add -A && git commit -m "mycoder <version>" && git push
```

The tap is [`OIerYangJZ/homebrew-mycoder`](https://github.com/OIerYangJZ/homebrew-mycoder),
opened on 2026-09-06. After which:

```sh
brew tap OIerYangJZ/mycoder
brew trust OIerYangJZ/mycoder
brew install mycoder
```

The formula is not committed to the tap by CI. A workflow with write access to
another repository is a wider capability than publishing one, and copying one file
is a human step because opening a tap is.

## The freeze this sits under

ADR-0027 §5: **`v0.1.0-alpha.12` is the last tag cut while CLOSURE A is open.** That
clause is about tags, and publishing is the same assertion through a different
channel — "this is usable by someone else". The machinery above is built and gated;
whether to use it is a decision that belongs with the clause, not with the workflow.
