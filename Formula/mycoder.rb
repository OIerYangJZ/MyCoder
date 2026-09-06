# The Homebrew formula, kept in this repository rather than only in the tap.
#
# A tap has to be its own repository named `homebrew-<something>`, and the formula
# in it would then be a copy of a version number that lives here — which is one
# more thing that can be stale and no way to notice. So this file is the source,
# `pnpm release:formula` rewrites its `url` and `sha256` from the artifact that was
# actually packed, and `pnpm mirrors` refuses if its version has drifted from
# `package.json`. Publishing the tap is copying this file into it.
#
# The `url` is the npm registry tarball rather than a GitHub source archive on
# purpose: it is byte-identical to the artifact the release gate installed and ran,
# because `npm publish` uploads the tarball it was given rather than re-packing one.
# A formula that built from a source archive would be checking a different thing
# from the one the evidence describes.
class Mycoder < Formula
  desc "Coding agent kernel for the terminal, with explicit security boundaries"
  homepage "https://github.com/OIerYangJZ/MyCoder"
  url "https://registry.npmjs.org/mycoder-cli/-/mycoder-cli-0.1.0-alpha.13.tgz"
  # Stated rather than inferred. Homebrew derives a version from the url when it can,
  # and `mycoder-cli-0.1.0-alpha.13.tgz` is exactly the shape it guesses wrong on —
  # the prerelease suffix reads as part of the filename rather than the version.
  version "0.1.0-alpha.13"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  # Not `depends_on "node"` alone: the kernel needs >= 22.18 for native type
  # stripping and `bin/mycoder.mjs` refuses to start below it (ADR-0019). Brew's
  # `node` is well above that, and the check stays in the binary regardless.
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mycoder --version")

    # `doctor` builds no session and writes nothing, which is what makes it safe to
    # run here. Its exit code is deliberately not asserted: it is 0 with a provider
    # configured and 3 without one, and which of those a build machine has is not
    # this formula's business. What is being tested is that the binary starts and
    # the Node runtime check passes — so the assertion is on the verdict line.
    output = shell_output("#{bin}/mycoder doctor 2>&1 || true")
    assert_match(/Ready\.|Not ready/, output)
  end
end
