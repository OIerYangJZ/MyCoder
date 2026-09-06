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

Neither of these lives in the repository, and neither can be set from here:

| Secret / setting      | Where                   | What it is for                                                   |
| --------------------- | ----------------------- | ---------------------------------------------------------------- |
| `NPM_TOKEN`           | repository secret       | an npm **automation** token for the account owning `mycoder-cli` |
| environment `release` | Settings → Environments | where a required reviewer goes, if publishing should need one    |

`GITHUB_TOKEN` is provided by Actions; the `publish` job asks for `contents: write`
to create the release and `id-token: write` for npm provenance.

Nothing else is needed. The first publish also has to happen from an account that
owns the name, so if `mycoder-cli` has never been published, do that once by hand
before relying on the workflow.

## Cutting a release, from a checkout

```sh
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
3. `npm publish <tarball> --provenance`, which signs a statement binding those bytes
   to this workflow, this commit and this repository;
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

### Opening the tap, from a checkout

Not done, and one command when it is wanted:

```sh
gh repo create OIerYangJZ/homebrew-mycoder --public \
  --description "Homebrew tap for MyCoder"
git clone git@github.com:OIerYangJZ/homebrew-mycoder.git
mkdir -p homebrew-mycoder/Formula
cp Formula/mycoder.rb homebrew-mycoder/Formula/
# then fill in the url and sha256 the publish job printed
cd homebrew-mycoder && git add -A && git commit -m "mycoder 0.1.0" && git push
```

After which:

```sh
brew tap OIerYangJZ/mycoder
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
