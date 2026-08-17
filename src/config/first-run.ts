/**
 * First run: usable, or blocked with a remedy. Never anything else (alpha.8 §10).
 *
 * §10 permits exactly two outcomes for a fresh install with no configuration:
 *
 *     usable   — a provider was discoverable
 *     blocked  — naming the file to create, the key to set, and the command to
 *                verify
 *
 * and forbids three: a stack trace, an empty prompt that fails on the first
 * turn, and a silently degraded session.
 *
 * Before alpha.8 the kernel produced the third. `defaultConfig()` resolves the
 * model alias `fake`, so a machine that had never been configured started a real
 * session against `FakeModel`, answered its first task with
 * `(fake model: script exhausted)`, and **exited 0**. Everything about that is a
 * success report for a session that did nothing.
 *
 * The fix is not to remove the fake model — the entire offline suite is built on
 * it, and `model.default = "fake"` is a legitimate thing to write. It is to tell
 * *chosen* apart from *defaulted into*, which is what `explicitModelDefault`
 * carries.
 *
 * This module decides and explains. It never writes anything: a first-run helper
 * that creates configuration is a first-run helper that can create the wrong
 * configuration, and §11 is emphatic that a setup flow producing a file the
 * kernel then refuses is worse than no setup flow at all.
 */

import * as path from 'node:path';

import { isWithin, type CanonicalPath } from '../util/paths.ts';
import type { KernelConfig } from './schema.ts';

/**
 * Is this workspace one an agent should be pointed at? (ADR-0028.)
 *
 * A workspace that **contains the user config directory** is almost always a home
 * directory somebody ran the command in, and it hands the session write access to
 * everything under it — including the configuration that decides where prompts are
 * sent and where credentials live.
 *
 * Until alpha.12 this was refused only by accident, and only for some people: the
 * credential-file check refuses a key inside the workspace, so `api_key_file` users
 * were stopped and `api_key_env` users were not. Same directory, same exposure,
 * opposite outcome — and the message told the file users to move a correctly-placed
 * credential. The refusal is now about the workspace, for everyone, from one place.
 *
 * Deliberately **not** "is this the home directory": the test is containment of the
 * config directory, which catches `/`, `$HOME`, and a `--cwd` that resolved higher
 * than intended, and does not fire for the ordinary case of a project that happens
 * to live under `$HOME`.
 */
export interface WorkspaceVerdict {
  ok: boolean;
  /** What is wrong, for the error message and for `doctor`'s finding. */
  problem?: string;
  remedy?: string;
}

export function checkWorkspaceRoot(
  workspaceRoot: CanonicalPath,
  userConfigDir: CanonicalPath,
): WorkspaceVerdict {
  if (!isWithin(workspaceRoot, userConfigDir)) return { ok: true };

  return {
    ok: false,
    problem:
      `the workspace is ${workspaceRoot}, which contains your configuration directory ` +
      `${userConfigDir}. A session there could read and write your own configuration and ` +
      'credentials, and that is almost never what running the command in this directory meant.',
    remedy: [
      'Run MyCoder from the project directory you mean, or name it explicitly:',
      '',
      '    cd <project> && mycoder',
      '    mycoder --cwd <project>',
      '',
      'Nothing needs to move: the credential belongs where it is.',
    ].join('\n'),
  };
}

export interface ReadinessInput {
  config: KernelConfig;
  /** Config files that were actually read. Empty on a fresh install. */
  sources: readonly string[];
  /** Did a config layer or CLI flag name a model, or is `fake` a default? */
  explicitModelDefault: boolean;
  /** `~/.config/mycoder` or the platform equivalent — where the fix goes. */
  userConfigDir: string;
  /** A caller-supplied fake model, i.e. a test. Always ready. */
  injectedFakeModel?: boolean;
  /** `-m/--model`, which names an alias the config still has to define. */
  aliasOverride?: string;
}

export type Readiness =
  | {
      ready: true;
      alias: string;
      /** Set when the alias was inferred rather than named. Disclosed at startup. */
      inferred?: string;
    }
  | {
      ready: false;
      /** `safeDetails.problem`, so a script can branch without reading prose. */
      problem: 'no-provider-configured' | 'ambiguous-default' | 'alias-undefined' | 'provider-undefined';
      message: string;
      remedy: string;
    };

/**
 * Can this installation talk to a model?
 *
 * Three ways to answer no, kept apart because their remedies are different
 * files: nothing is configured at all, the chosen alias is not defined, or the
 * alias names a provider that is not.
 */
export function assessReadiness(input: ReadinessInput): Readiness {
  if (input.injectedFakeModel) return { ready: true, alias: input.config.model.default ?? 'fake' };

  const alias = input.aliasOverride ?? input.config.model.default ?? 'fake';

  // `-m <alias>` is itself an explicit choice of model, including `-m fake`.
  //
  // Without this, `mycoder -m fake "…"` on a machine with no config file was
  // refused — the offline path the README documents, and the one the eval runner
  // uses in scripted mode. The readiness check exists to catch a *default* nobody
  // chose (§10); a flag on the command line is the opposite of that.
  const chosen = input.explicitModelDefault || input.aliasOverride !== undefined;
  const aliases = input.config.model.aliases ?? {};
  const providers = input.config.model.providers ?? {};

  // Nothing anywhere said which model to use, so `fake` is a default rather than
  // a decision. Whether that is a problem depends on what *is* configured.
  if (alias === 'fake' && !chosen) {
    // A config that declares one usable alias has told us which model to use as
    // clearly as `default =` would have; §10's first outcome is "usable, because
    // a provider was discoverable", and this is what discoverable means. It is
    // reported as inferred at startup, so nobody has to guess which one it
    // picked.
    const usable = Object.keys(aliases).filter((name) => providers[aliases[name]!.provider]);

    if (usable.length === 1) return { ready: true, alias: usable[0]!, inferred: usable[0]! };

    if (usable.length > 1) {
      return {
        ready: false,
        problem: 'ambiguous-default',
        message: `${usable.length} model aliases are configured and none is the default: ${usable.join(', ')}.`,
        remedy:
          'Guessing would silently send your prompts to one provider rather than another, so pick one.\n\n' +
          `Add to ${input.userConfigDir}/config.toml:\n\n` +
          '     [model]\n' +
          `     default = "${usable[0]}"\n\n` +
          'or select one for a single run with `-m/--model <alias>`.\n\n' +
          'Check it: mycoder doctor\n',
      };
    }

    return {
      ready: false,
      problem: 'no-provider-configured',
      message:
        input.sources.length === 0
          ? 'No configuration was found, so there is no model to talk to.'
          : `No model provider is configured in ${input.sources.join(' or ')}, so there is no model to talk to.`,
      remedy: providerRemedy(input.userConfigDir),
    };
  }

  // `fake` chosen deliberately. Offline tests, and anyone reproducing them.
  if (alias === 'fake') return { ready: true, alias };

  const entry = aliases[alias];
  if (!entry) {
    const known = Object.keys(aliases);
    return {
      ready: false,
      problem: 'alias-undefined',
      message: `The model alias "${alias}" is not defined.`,
      remedy:
        (known.length > 0
          ? `Defined aliases: ${known.join(', ')}.\n\n`
          : 'No aliases are defined at all.\n\n') + providerRemedy(input.userConfigDir),
    };
  }

  if (!providers[entry.provider]) {
    return {
      ready: false,
      problem: 'provider-undefined',
      message:
        `The alias "${alias}" names provider "${entry.provider}", which is not defined ` +
        'in your user config.',
      remedy:
        'Provider endpoints may only be declared in user config — a project may select an alias, ' +
        'never decide where prompts are sent. If you declared this provider in a project ' +
        `config it was ignored, and the warning saying so is in \`mycoder --print-config\`.\n\n` +
        providerRemedy(input.userConfigDir),
    };
  }

  return { ready: true, alias };
}

/**
 * The three things §10 requires: the file, the keys, and how to check.
 *
 * A copy-pasteable block rather than a description of one. The two values a
 * reader must change are marked, because the failure this is preventing is not
 * "the user did not know a config file existed" — it is "the user wrote one and
 * it did not work".
 */
export function providerRemedy(userConfigDir: string): string {
  const file = path.join(userConfigDir, 'config.toml');
  const keyFile = path.join(userConfigDir, 'secrets', 'provider.key');

  return [
    `1. Create ${file}:`,
    '',
    '     [model.provider.myprovider]',
    '     protocol     = "openai-chat"          # or anthropic-messages / openai-responses',
    '     base_url     = "https://api.example.com"      # <- your provider',
    '     api_key_file = "secrets/provider.key"         # relative to this config directory',
    '',
    '     [model.profile.myprofile]',
    '     context_window = 128000',
    '',
    '     [model.alias.mymodel]',
    '     provider = "myprovider"',
    '     model    = "the-model-id"                     # <- your model',
    '     profile  = "myprofile"',
    '',
    '     [model]',
    '     default = "mymodel"',
    '',
    `2. Put the key in ${keyFile}, readable only by you:`,
    '',
    `     mkdir -p ${path.dirname(keyFile)}`,
    `     printf %s "$YOUR_API_KEY" | mycoder setup-credential ${keyFile}`,
    '',
    '   The key never goes in the config file itself, and never inside a repository:',
    '   the kernel refuses to read a credential that is world-readable or that lives',
    '   in the workspace.',
    '',
    '3. Check it:',
    '',
    '     mycoder doctor',
    '',
  ].join('\n');
}
