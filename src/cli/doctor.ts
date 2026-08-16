/**
 * `mycoder doctor` — the command §10 tells people to run (alpha.8 §10, §12, §16).
 *
 * Two design rules, both learned from the alternative not working:
 *
 *   **It does not build a kernel.** Every question it answers is a question you
 *   ask precisely when the kernel will *not* start, so a diagnostic that needed a
 *   running kernel would be unavailable exactly when it is wanted. It reads
 *   configuration directly.
 *
 *   **It never repairs anything.** It reports and names a remedy. A doctor that
 *   silently fixed a permission or wrote a config file would train people not to
 *   look at what it changed, and §11 is explicit that a setup flow producing
 *   something the kernel later refuses is worse than no setup flow.
 *
 * The same reasoning applies to `--print-config`, which is why it is here too:
 * before alpha.8 it went through `createKernel`, so a workspace whose config
 * could not be honoured could not print its own config.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { APP_DISPLAY_NAME } from '../app.ts';
import { loadConfig, describeConfig } from '../config/config.ts';
import { assessReadiness } from '../config/first-run.ts';
import { WEAKENING_KEYS, CEILING_PINNED } from '../config/weakening.ts';
import { checkCredentialFile, chooseCredentialSource } from '../security/credential-file.ts';
import { canonicalize, type CanonicalPath } from '../util/paths.ts';
import type { KernelConfig } from '../config/schema.ts';
import { resolveKernelDirs, type KernelDirs } from '../util/platform.ts';
import { probeContainerRuntime } from '../execution/container.ts';
import { sandboxBinaryState } from '../execution/linux-native/build.ts';
import { resolveLauncherPath, resolveLauncherSourcePath } from '../execution/linux-native/paths.ts';
import { KERNEL_VERSION } from '../kernel.ts';
import { EXIT, type ExitCode } from './exit-codes.ts';

export interface DoctorOptions {
  workspaceDir: string;
  dirs?: KernelDirs;
  /** `-m/--model`, which changes which alias has to resolve. */
  modelOverride?: string;
  json: boolean;
  /** Probing docker spawns a process; the offline suite turns it off. */
  probeBackends?: boolean;
}

type Level = 'ok' | 'warn' | 'blocked';

interface Finding {
  area: string;
  level: Level;
  detail: string;
  remedy?: string;
}

export interface DoctorReport {
  schema: 'mycoder.v1';
  type: 'doctor';
  version: string;
  commit: string | null;
  node: string;
  platform: string;
  findings: Finding[];
  ok: boolean;
  exit: ExitCode;
}

export async function runDoctor(opts: DoctorOptions): Promise<{ report: DoctorReport; text: string }> {
  const dirs = opts.dirs ?? resolveKernelDirs();
  const findings: Finding[] = [];

  // --- install ---------------------------------------------------------------
  const commit = await readBuildCommit();
  findings.push({
    area: 'install',
    level: 'ok',
    detail:
      `${APP_DISPLAY_NAME} ${KERNEL_VERSION}` +
      (commit ? ` · commit ${commit}` : ' · commit unknown (running from a source tree, not an artifact)'),
  });
  findings.push({
    area: 'runtime',
    level: 'ok',
    detail: `Node ${process.versions.node} on ${process.platform}/${process.arch}`,
  });

  // --- configuration ---------------------------------------------------------
  const workspaceRoot = (await canonicalize(opts.workspaceDir, { cwd: process.cwd() })).path;
  const loaded = await loadConfig({ workspaceRoot, userConfigDir: dirs.config });
  const config = loaded.config;

  findings.push({
    area: 'config',
    level: 'ok',
    detail:
      loaded.sources.length > 0
        ? `read ${loaded.sources.join(', ')}`
        : `no config file found; looked for ${path.join(dirs.config, 'config.toml')}`,
  });

  for (const warning of config.warnings) {
    // A parse failure is the one warning that changes what the kernel enforces
    // rather than merely what it does, so it is a `warn` even though the session
    // would still start.
    findings.push({ area: 'config', level: 'warn', detail: warning });
  }

  // --- provider --------------------------------------------------------------
  const readiness = assessReadiness({
    config,
    sources: loaded.sources,
    explicitModelDefault: loaded.explicitModelDefault,
    userConfigDir: dirs.config,
    ...(opts.modelOverride ? { aliasOverride: opts.modelOverride } : {}),
  });

  if (readiness.ready) {
    findings.push({
      area: 'provider',
      level: 'ok',
      detail: readiness.inferred
        ? `model "${readiness.alias}" (inferred: it is the only alias configured)`
        : `model "${readiness.alias}"`,
    });
    await checkCredential(findings, config, readiness.alias, dirs, workspaceRoot);
  } else {
    findings.push({
      area: 'provider',
      level: 'blocked',
      detail: readiness.message,
      remedy: readiness.remedy,
    });
  }

  // --- boundaries this configuration relaxes (§12) ----------------------------
  const relaxed = WEAKENING_KEYS.filter((k) => k.isSet(config));
  if (relaxed.length === 0) {
    findings.push({
      area: 'boundaries',
      level: 'ok',
      detail: 'no configured relaxation; every default boundary is at its strictest',
    });
  } else {
    for (const key of relaxed) {
      findings.push({
        area: 'boundaries',
        level: 'warn',
        detail: `${key.key} — ${key.weakens}. Still denied: ${key.stillDenied}.`,
      });
    }
  }

  // --- backends --------------------------------------------------------------
  if (opts.probeBackends !== false) await checkBackends(findings);

  const blocked = findings.some((f) => f.level === 'blocked');
  const report: DoctorReport = {
    schema: 'mycoder.v1',
    type: 'doctor',
    version: KERNEL_VERSION,
    commit,
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    findings,
    ok: !blocked,
    exit: blocked ? EXIT.CONFIG : EXIT.OK,
  };

  return { report, text: opts.json ? `${JSON.stringify(report)}\n` : render(report) };
}

/** `--print-config`, without needing a kernel that can start. */
export async function printConfig(opts: {
  workspaceDir: string;
  dirs?: KernelDirs;
}): Promise<{ text: string; exit: ExitCode }> {
  const dirs = opts.dirs ?? resolveKernelDirs();
  const workspaceRoot = (await canonicalize(opts.workspaceDir, { cwd: process.cwd() })).path;
  const loaded = await loadConfig({ workspaceRoot, userConfigDir: dirs.config });
  return { text: `${describeConfig(loaded.config, loaded.sources)}\n`, exit: EXIT.OK };
}

async function checkCredential(
  findings: Finding[],
  config: KernelConfig,
  alias: string,
  dirs: KernelDirs,
  workspaceRoot: CanonicalPath,
): Promise<void> {
  const entry = config.model.aliases?.[alias];
  if (!entry) return;
  const provider = config.model.providers?.[entry.provider];
  if (!provider) return;

  const choice = chooseCredentialSource({
    ...(provider.apiKeyFile ? { apiKeyFile: provider.apiKeyFile } : {}),
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
  });

  if (choice.kind === 'none') {
    findings.push({
      area: 'credential',
      level: 'blocked',
      detail: `Provider "${entry.provider}" names neither api_key_file nor api_key_env, so there is no credential to send.`,
      remedy:
        'Add `api_key_file = "secrets/<name>.key"` to the provider block. A literal `api_key` in the\n' +
        'config file is refused: config is the one artifact people paste into issues.',
    });
    return;
  }

  if (choice.kind === 'env') {
    findings.push({
      area: 'credential',
      level: 'ok',
      detail: `from the environment variable ${choice.selector}`,
    });
    return;
  }

  // The file case is the one worth checking properly: `checkCredentialFile` is
  // the same function the kernel uses at startup, so a doctor that reported ok
  // here and a kernel that refused there would be the worst possible outcome.
  try {
    const info = await checkCredentialFile(choice.selector!, {
      cwd: dirs.config,
      workspaceRoot,
    });
    findings.push({
      area: 'credential',
      level: 'ok',
      detail: `file ${info.path}${info.mode !== undefined ? ` (mode 0${info.mode.toString(8)})` : ''}`,
    });
  } catch (e) {
    const err = e as { kernelError?: { message: string; safeDetails?: Record<string, unknown> } };
    findings.push({
      area: 'credential',
      level: 'blocked',
      detail: err.kernelError?.message ?? String(e),
      remedy:
        'The kernel never repairs this file: `chmod 0600` on a path you chose is an unrequested\n' +
        'change to something outside the workspace, and a tool that silently fixes a permission\n' +
        'problem trains people not to look at it.',
    });
  }
}

async function checkBackends(findings: Finding[]): Promise<void> {
  // local is always available; it is the one with the weakest claim, and
  // `/status` says so rather than this report repeating it.
  try {
    const probe = await probeContainerRuntime();
    findings.push(
      probe.ok && probe.info
        ? {
            area: 'backend/container',
            level: 'ok',
            detail:
              `${probe.info.binary} ${probe.info.serverVersion} on ${probe.info.serverPlatform}` +
              // alpha.5 §37/§38: only a native Linux engine is release evidence
              // for isolation, and the report says which one this is rather than
              // leaving the reader to infer it from the OS.
              (probe.info.nativeLinux ? ' — native Linux engine' : ' — not a native Linux engine (§38)'),
          }
        : {
            area: 'backend/container',
            level: 'warn',
            detail: `unavailable: ${probe.detail}`,
            remedy: '`--backend container` will refuse to start rather than run with weaker isolation.',
          },
    );
  } catch (e) {
    findings.push({
      area: 'backend/container',
      level: 'warn',
      detail: `could not be probed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  if (process.platform !== 'linux') {
    findings.push({
      area: 'backend/linux-native',
      level: 'warn',
      detail: `not available: the native sandbox is Linux-only and this is ${process.platform}`,
      remedy: '`--backend linux-native` will refuse here. It never degrades to local.',
    });
    return;
  }

  const launcher = sandboxBinaryState(resolveLauncherPath(), resolveLauncherSourcePath());
  findings.push(
    launcher.ok
      ? {
          area: 'backend/linux-native',
          level: 'ok',
          detail:
            `launcher verified: ${launcher.binary} ` +
            `(source ${launcher.manifest.sourceSha256.slice(0, 12)}, built ${launcher.manifest.builtAt})`,
        }
      : {
          area: 'backend/linux-native',
          level: 'warn',
          detail: `${launcher.problem}: ${launcher.reason}`,
          remedy: launcher.remedy,
        },
  );
}

/** `build-info.json` exists only in a packed artifact (ADR-0019 §6). */
async function readBuildCommit(): Promise<string | null> {
  try {
    const url = new URL('../../build-info.json', import.meta.url);
    const parsed = JSON.parse(await readFile(url, 'utf8')) as { commit?: string };
    return parsed.commit ?? null;
  } catch {
    return null;
  }
}

function render(report: DoctorReport): string {
  const mark: Record<Level, string> = { ok: '  ok   ', warn: '  warn ', blocked: '  BLOCK' };
  const lines = [`${APP_DISPLAY_NAME} doctor`, ''];

  for (const f of report.findings) {
    lines.push(`${mark[f.level]} ${f.area.padEnd(22)} ${f.detail}`);
    if (f.remedy) {
      for (const line of f.remedy.split('\n')) lines.push(`         ${line}`);
      lines.push('');
    }
  }

  lines.push('');
  lines.push(
    report.ok
      ? 'Ready. Start a session with `mycoder` in the directory you want to work in.'
      : 'Not ready — see the BLOCK line(s) above. Nothing was changed.',
  );
  lines.push('');
  lines.push(
    'Config keys that can relax a boundary are audited in `docs/configuration-audit.md`;',
    `keys the system ceiling pins regardless of configuration: ${CEILING_PINNED.length} of them.`,
  );
  return lines.join('\n');
}
