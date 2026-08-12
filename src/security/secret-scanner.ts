/**
 * Content secret scanner (spec §13.2).
 *
 * Runs on anything about to cross a trust boundary: file content headed for the
 * model, tool stdout/stderr, hook output, and every egress payload.
 *
 * Design notes:
 *  - Patterns are high-confidence by default. A scanner that fires constantly
 *    gets disabled, and a disabled scanner protects nothing.
 *  - `confidence: 'medium'` rules exist for the generic `KEY = value` shape.
 *    They are enabled for egress (where a false positive costs a redacted
 *    string) and for model context, but the caller can restrict to `high`.
 *  - The scanner is not the primary defence. Path-level hard deny is. This is
 *    the second layer, for credentials that end up somewhere they should not be.
 */

import { fingerprint } from '../util/ids.ts';

export type SecretConfidence = 'high' | 'medium';

export interface SecretRule {
  id: string;
  description: string;
  confidence: SecretConfidence;
  pattern: RegExp;
  /** Which capture group holds the actual secret; 0 means the whole match. */
  group?: number;
}

export interface SecretFinding {
  ruleId: string;
  confidence: SecretConfidence;
  /** Byte offsets into the scanned string. */
  start: number;
  end: number;
  /** Non-reversible identifier. The value itself never leaves the broker. */
  fingerprint: string;
  /** Length of the matched secret, useful for metrics without disclosure. */
  length: number;
}

/**
 * Rules are ordered most-specific first so that, e.g., an OpenAI key is
 * attributed to the OpenAI rule rather than the generic assignment rule.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key-block',
    description: 'PEM private key block',
    confidence: 'high',
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  },
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key',
    confidence: 'high',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{24,}/g,
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key',
    confidence: 'high',
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'stripe-secret-key',
    description: 'Stripe secret key',
    confidence: 'high',
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    confidence: 'high',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id',
    confidence: 'high',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key',
    confidence: 'high',
    pattern: /\baws_secret_access_key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    group: 1,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    confidence: 'high',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    confidence: 'high',
    pattern: /\bxox[baprse]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    confidence: 'high',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    confidence: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'bearer-token',
    description: 'Authorization bearer token',
    confidence: 'high',
    pattern: /\b[Aa]uthorization\s*[:=]\s*["']?(?:[Bb]earer|[Tt]oken)\s+([A-Za-z0-9._~+/-]{20,}=*)/g,
    group: 1,
  },
  {
    id: 'private-key-openssh',
    description: 'OpenSSH private key body',
    confidence: 'high',
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
  },
  {
    id: 'generic-credential-assignment',
    description: 'Credential-shaped assignment (KEY=value)',
    confidence: 'medium',
    // Requires a credential-ish key name AND a value with enough entropy shape.
    pattern:
      /\b[A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIAL|ACCESS_?KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{12,})["']?/gi,
    group: 1,
  },
];

/** Values that look credential-shaped but are conventional placeholders. */
const PLACEHOLDERS = new Set(
  [
    'changeme',
    'your_api_key_here',
    'xxxxxxxxxxxx',
    'placeholder',
    'example',
    'redacted',
    'undefined',
    'null',
    'none',
    'todo',
  ].map((s) => s.toLowerCase()),
);

function isPlaceholder(value: string): boolean {
  const v = value.toLowerCase();
  if (PLACEHOLDERS.has(v)) return true;
  if (/^[x*.\-_]{6,}$/i.test(value)) return true;
  if (v.startsWith('${') || v.startsWith('$(')) return true; // shell interpolation
  if (v.startsWith('<') && v.endsWith('>')) return true; // <your-key>
  if (v.startsWith('secret_ref://')) return true; // our own reference form
  if (v.startsWith('[redacted:')) return true;
  return false;
}

export interface ScanOptions {
  minConfidence?: SecretConfidence;
  /** Extra literal values (e.g. registered by the user) to treat as secrets. */
  literals?: readonly string[];
}

export function scanSecrets(text: string, opts: ScanOptions = {}): SecretFinding[] {
  const minConfidence = opts.minConfidence ?? 'medium';
  const findings: SecretFinding[] = [];

  for (const rule of SECRET_RULES) {
    if (minConfidence === 'high' && rule.confidence !== 'high') continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const groupIndex = rule.group ?? 0;
      const value = m[groupIndex];
      if (value === undefined || value.length === 0) continue;
      if (isPlaceholder(value)) continue;

      const start = groupIndex === 0 ? m.index : m.index + m[0].indexOf(value);
      findings.push({
        ruleId: rule.id,
        confidence: rule.confidence,
        start,
        end: start + value.length,
        fingerprint: fingerprint(value),
        length: value.length,
      });
    }
  }

  for (const literal of opts.literals ?? []) {
    if (literal.length < 4) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(literal, from);
      if (at < 0) break;
      findings.push({
        ruleId: 'registered-literal',
        confidence: 'high',
        start: at,
        end: at + literal.length,
        fingerprint: fingerprint(literal),
        length: literal.length,
      });
      from = at + literal.length;
    }
  }

  return dedupe(findings);
}

/** Overlapping findings collapse to the widest span, so redaction is stable. */
function dedupe(findings: SecretFinding[]): SecretFinding[] {
  const sorted = [...findings].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: SecretFinding[] = [];
  for (const f of sorted) {
    const last = out.at(-1);
    if (last && f.start < last.end) {
      if (f.end > last.end) last.end = f.end;
      continue;
    }
    out.push({ ...f });
  }
  return out;
}

export function hasSecret(text: string, opts: ScanOptions = {}): boolean {
  return scanSecrets(text, opts).length > 0;
}
