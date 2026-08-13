/**
 * Protected paths (spec §13.1 and §11.3).
 *
 * These are the hard-deny rules no profile, skill, agent, hook or CLI flag can
 * lift. They are evaluated on **canonical** paths, so a symlink pointing at
 * `.env` and a `../../.env` traversal both land on the same rule.
 *
 * `.gitignore` is not consulted. It is a convenience for humans, not a security
 * boundary, and treating it as one is exactly the mistake this module exists to
 * avoid.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';

import { APP_NAME } from '../app.ts';
import { GlobSet } from '../util/glob.ts';
import { toPosix, type CanonicalPath } from '../util/paths.ts';

export type ProtectionReason =
  | 'secret-file'
  | 'credential-directory'
  | 'configured-credential'
  | 'system-directory'
  | 'kernel-policy'
  | 'reference-tree';

export interface ProtectionVerdict {
  protected: boolean;
  reason?: ProtectionReason;
  /** The rule that matched, for `/permissions explain`. */
  rule?: string;
  /** True when the rule only forbids writing, not reading. */
  writeOnly?: boolean;
}

/**
 * Filenames that are secrets regardless of where they live.
 * Matched against the whole POSIX-ised canonical path.
 */
const SECRET_FILE_PATTERNS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/*.jks',
  '**/id_rsa',
  '**/id_dsa',
  '**/id_ecdsa',
  '**/id_ed25519',
  '**/*.ppk',
  '**/.netrc',
  '**/.npmrc',
  '**/.pypirc',
  '**/credentials.json',
  '**/service-account*.json',
  '**/.htpasswd',
  '**/secrets.yaml',
  '**/secrets.yml',
];

/**
 * `.env` files that are templates, not credentials. The exception list is
 * matched *after* canonicalisation so `.env.example -> .env` (a symlink) is
 * still caught by the rule above.
 */
const SECRET_FILE_EXCEPTIONS: readonly string[] = [
  '**/.env.example',
  '**/.env.sample',
  '**/.env.template',
  '**/.env.dist',
  '**/.env.defaults',
  '**/*.pem.example',
];

/** Directories that hold credentials for the whole machine. */
function credentialDirectories(home: string): string[] {
  const h = toPosix(home);
  return [
    `${h}/.ssh/**`,
    `${h}/.ssh`,
    `${h}/.aws/**`,
    `${h}/.config/gcloud/**`,
    `${h}/.azure/**`,
    `${h}/.kube/config`,
    `${h}/.kube/**`,
    `${h}/.docker/config.json`,
    `${h}/.gnupg/**`,
    `${h}/.password-store/**`,
    `${h}/Library/Keychains/**`,
    `${h}/.local/share/keyrings/**`,
    `${h}/.netrc`,
    `${h}/.npmrc`,
    `${h}/.pypirc`,
    `${h}/.git-credentials`,
    `${h}/.config/gh/hosts.yml`,
    `${h}/.cargo/credentials*`,
  ];
}

/** System locations that must never be written, and mostly never read. */
const SYSTEM_WRITE_DENY: readonly string[] = [
  '/etc/**',
  '/System/**',
  '/Library/LaunchDaemons/**',
  '/Library/LaunchAgents/**',
  '/usr/**',
  '/bin/**',
  '/sbin/**',
  '/boot/**',
  '/private/etc/**',
  '/var/root/**',
  'C:/Windows/**',
];

const SYSTEM_READ_DENY: readonly string[] = [
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/sudoers.d/**',
  '/etc/master.passwd',
  '/private/etc/master.passwd',
  '/var/root/**',
];

/** Kernel-owned files a session must not rewrite to widen its own ceiling. */
function kernelPolicyPaths(home: string, configDir: string): string[] {
  return [
    `${toPosix(configDir)}/config.toml`,
    `${toPosix(configDir)}/permissions.toml`,
    `${toPosix(configDir)}/remotes.toml`,
    // Both the current and the legacy name: a session must not be able to
    // rewrite its own policy under either.
    `${toPosix(home)}/.config/${APP_NAME}/**`,
    `${toPosix(home)}/.config/agent/**`,
  ];
}

export interface ProtectedPathsOptions {
  home?: string;
  /** User config directory, whose policy files are write-protected. */
  configDir?: string;
  /** Reference repositories: readable, never writable (spec §23). */
  referenceRoots?: readonly CanonicalPath[];
  /** Additional hard-deny read patterns from configuration. */
  extraSecretPatterns?: readonly string[];
  /**
   * Canonical paths of configured provider credential files (alpha.3 §7).
   *
   * These are exact paths rather than patterns because they come from the
   * kernel's own configuration, not from a user-supplied glob: the path the
   * SecretBroker reads is the path that becomes unreachable, with no matching
   * rule in between that could be written slightly wrong. A credential store
   * the agent can read is not a credential store.
   */
  credentialPaths?: readonly CanonicalPath[];
}

export class ProtectedPaths {
  private readonly secretFiles: GlobSet;
  private readonly secretExceptions: GlobSet;
  private readonly credentialDirs: GlobSet;
  private readonly systemWrite: GlobSet;
  private readonly systemRead: GlobSet;
  private readonly kernelPolicy: GlobSet;
  private readonly referenceRoots: readonly CanonicalPath[];
  private readonly credentialPaths: Set<string>;

  constructor(opts: ProtectedPathsOptions = {}) {
    const home = opts.home ?? homedir();
    const configDir = opts.configDir ?? path.join(home, '.config', APP_NAME);

    this.secretFiles = new GlobSet([...SECRET_FILE_PATTERNS, ...(opts.extraSecretPatterns ?? [])]);
    this.secretExceptions = new GlobSet(SECRET_FILE_EXCEPTIONS);
    this.credentialDirs = new GlobSet(credentialDirectories(home));
    this.systemWrite = new GlobSet(SYSTEM_WRITE_DENY);
    this.systemRead = new GlobSet(SYSTEM_READ_DENY);
    this.kernelPolicy = new GlobSet(kernelPolicyPaths(home, configDir));
    this.referenceRoots = opts.referenceRoots ?? [];
    // Compared case-insensitively, matching how GlobSet treats the other rules:
    // on APFS and NTFS `deepseek.key` and `DeepSeek.key` are the same file, and
    // a case-sensitive check here would be an exact-path bypass.
    this.credentialPaths = new Set(
      (opts.credentialPaths ?? []).map((p) => toPosix(p).normalize('NFC').toLowerCase()),
    );
  }

  /** True when this exact path is a configured provider credential file. */
  private isConfiguredCredential(canonical: CanonicalPath): boolean {
    if (this.credentialPaths.size === 0) return false;
    return this.credentialPaths.has(toPosix(canonical).normalize('NFC').toLowerCase());
  }

  /**
   * Can this canonical path be read into the model's context?
   *
   * Reading a file to hash it is a different question — see `canRead`.
   */
  checkReadToModel(canonical: CanonicalPath): ProtectionVerdict {
    const p = toPosix(canonical);

    // Checked first so the verdict names the specific reason. A configured
    // credential often *also* matches `**/*.key`, but a user who names their
    // file `deepseek.txt` must get exactly the same denial.
    if (this.isConfiguredCredential(canonical)) {
      return { protected: true, reason: 'configured-credential', rule: 'configured-credential' };
    }
    if (this.secretFiles.matches(p) && !this.secretExceptions.matches(p)) {
      return {
        protected: true,
        reason: 'secret-file',
        rule: this.secretFiles.firstMatch(p) ?? 'secret-file',
      };
    }
    if (this.credentialDirs.matches(p)) {
      return {
        protected: true,
        reason: 'credential-directory',
        rule: this.credentialDirs.firstMatch(p) ?? 'credential-directory',
      };
    }
    if (this.systemRead.matches(p)) {
      return {
        protected: true,
        reason: 'system-directory',
        rule: this.systemRead.firstMatch(p) ?? 'system-read',
      };
    }
    return { protected: false };
  }

  /** Kernel-internal reads (hashing, freshness) are broader but not unlimited. */
  checkRead(canonical: CanonicalPath): ProtectionVerdict {
    const p = toPosix(canonical);
    // Denied even for kernel-internal reads. Hashing the file for freshness
    // would put its digest in the event log, which is a persisted oracle for a
    // credential nobody needs to track the mtime of.
    if (this.isConfiguredCredential(canonical)) {
      return { protected: true, reason: 'configured-credential', rule: 'configured-credential' };
    }
    if (this.credentialDirs.matches(p)) {
      return {
        protected: true,
        reason: 'credential-directory',
        rule: this.credentialDirs.firstMatch(p) ?? 'credential-directory',
      };
    }
    if (this.systemRead.matches(p)) {
      return { protected: true, reason: 'system-directory', rule: this.systemRead.firstMatch(p) };
    }
    return { protected: false };
  }

  checkWrite(canonical: CanonicalPath): ProtectionVerdict {
    const p = toPosix(canonical);

    // Writing is denied as well as reading. An agent that could overwrite the
    // credential file could swap in a key it controls, or empty it and take the
    // session offline — neither needs the ability to read the old value.
    if (this.isConfiguredCredential(canonical)) {
      return { protected: true, reason: 'configured-credential', rule: 'configured-credential' };
    }
    for (const root of this.referenceRoots) {
      const rootPosix = toPosix(root);
      if (p === rootPosix || p.startsWith(rootPosix + '/')) {
        return {
          protected: true,
          reason: 'reference-tree',
          rule: `${rootPosix}/**`,
          writeOnly: true,
        };
      }
    }
    if (this.kernelPolicy.matches(p)) {
      return {
        protected: true,
        reason: 'kernel-policy',
        rule: this.kernelPolicy.firstMatch(p),
        writeOnly: true,
      };
    }
    if (this.secretFiles.matches(p) && !this.secretExceptions.matches(p)) {
      return { protected: true, reason: 'secret-file', rule: this.secretFiles.firstMatch(p) };
    }
    if (this.credentialDirs.matches(p)) {
      return {
        protected: true,
        reason: 'credential-directory',
        rule: this.credentialDirs.firstMatch(p),
      };
    }
    if (this.systemWrite.matches(p)) {
      return { protected: true, reason: 'system-directory', rule: this.systemWrite.firstMatch(p) };
    }
    return { protected: false };
  }

  /** True when the path is inside a configured reference repository. */
  isReferencePath(canonical: CanonicalPath): boolean {
    const p = toPosix(canonical);
    return this.referenceRoots.some((r) => {
      const rp = toPosix(r);
      return p === rp || p.startsWith(rp + '/');
    });
  }

  /** Human-readable explanation for a denial, safe to show the model. */
  static explain(verdict: ProtectionVerdict, displayPath: string): string {
    switch (verdict.reason) {
      case 'secret-file':
        return `"${displayPath}" is treated as a secret file and is never made available. Use secret_ref:// if the value is genuinely needed by a command.`;
      case 'credential-directory':
        return `"${displayPath}" is inside a credential directory, which is permanently off limits.`;
      case 'configured-credential':
        return `"${displayPath}" is this kernel's own provider credential file and is never readable from a session.`;
      case 'system-directory':
        return `"${displayPath}" is a protected system location.`;
      case 'kernel-policy':
        return `"${displayPath}" is a kernel policy file and cannot be modified from inside a session.`;
      case 'reference-tree':
        return `"${displayPath}" is inside a reference repository, which is read-only.`;
      default:
        return `"${displayPath}" is protected.`;
    }
  }
}
