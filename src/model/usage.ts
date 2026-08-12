/**
 * Usage and cost accounting (alpha.2 §17, §18).
 *
 * Two rules shape this file.
 *
 * **Provenance is part of the number.** §17 asks for `reported | estimated |
 * unknown`, and that distinction is the whole value: a token count the provider
 * sent and a token count we guessed from byte length are not interchangeable,
 * and an eval that silently mixes them produces a `$/solved task` figure nobody
 * should trust.
 *
 * **Prices are configuration, not constants.** Provider pricing changes, varies
 * by tier, and differs between cached and fresh input. Hard-coding a number here
 * would produce confident, wrong costs. If no price is configured the cost is
 * reported as `unknown` — an absent figure is more useful than an invented one.
 */

import { estimateTokens } from '../util/text.ts';
import type { TokenUsage } from './ir.ts';

export type UsageProvenance = 'reported' | 'estimated' | 'unknown';

export interface UsageField {
  value: number;
  provenance: UsageProvenance;
}

export interface UsageReport {
  inputTokens: UsageField;
  outputTokens: UsageField;
  cachedInputTokens: UsageField;
  reasoningTokens: UsageField;
}

/** $ per million tokens. Supplied by configuration; never guessed. */
export interface ModelPricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
  /** Cached input is usually cheaper; falls back to `inputPerMTok`. */
  cachedInputPerMTok?: number;
}

export interface CostEstimate {
  usd: number;
  provenance: UsageProvenance;
  /** Why the figure is not `reported`, when it is not. */
  note?: string;
}

function field(value: number | undefined, estimate: number | undefined): UsageField {
  if (typeof value === 'number' && Number.isFinite(value)) return { value, provenance: 'reported' };
  if (typeof estimate === 'number' && Number.isFinite(estimate))
    return { value: estimate, provenance: 'estimated' };
  return { value: 0, provenance: 'unknown' };
}

export interface UsageEstimateInputs {
  /** Text that went into the request, for estimating input tokens. */
  requestText?: string;
  /** Text the model produced, for estimating output tokens. */
  responseText?: string;
}

/**
 * Resolve what the provider reported into a report with provenance.
 *
 * Estimation is deliberately crude and only fills genuine gaps — a provider that
 * reports usage always wins.
 */
export function resolveUsage(reported: TokenUsage, inputs: UsageEstimateInputs = {}): UsageReport {
  return {
    inputTokens: field(
      reported.inputTokens,
      inputs.requestText === undefined ? undefined : estimateTokens(inputs.requestText),
    ),
    outputTokens: field(
      reported.outputTokens,
      inputs.responseText === undefined ? undefined : estimateTokens(inputs.responseText),
    ),
    // There is no way to estimate a cache hit, so absent means unknown, not zero.
    cachedInputTokens: field(reported.cachedInputTokens, undefined),
    reasoningTokens: field(reported.reasoningTokens, undefined),
  };
}

/**
 * Estimate cost from a usage report and configured pricing.
 *
 * Returns `unknown` when no price is configured. §18 asks us to start collecting
 * `$/solved task`; it does not ask us to fabricate the numerator.
 */
export function estimateCost(usage: UsageReport, pricing: ModelPricing | undefined): CostEstimate {
  if (!pricing || (pricing.inputPerMTok === undefined && pricing.outputPerMTok === undefined)) {
    return {
      usd: 0,
      provenance: 'unknown',
      note: 'no pricing configured for this model; set [pricing] in config.toml',
    };
  }

  const fresh = Math.max(0, usage.inputTokens.value - usage.cachedInputTokens.value);
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok ?? 0;

  const usd =
    (fresh / 1e6) * (pricing.inputPerMTok ?? 0) +
    (usage.cachedInputTokens.value / 1e6) * cachedRate +
    (usage.outputTokens.value / 1e6) * (pricing.outputPerMTok ?? 0);

  // The cost is only as trustworthy as the least trustworthy input to it.
  const inputs = [usage.inputTokens.provenance, usage.outputTokens.provenance];
  const provenance: UsageProvenance = inputs.includes('unknown')
    ? 'unknown'
    : inputs.includes('estimated')
      ? 'estimated'
      : 'reported';

  const estimate: CostEstimate = { usd, provenance };
  if (provenance !== 'reported') {
    estimate.note = 'derived from at least one estimated or missing token count';
  }
  return estimate;
}

/**
 * Sum two reports, keeping the weaker provenance of each field.
 *
 * An `unknown` field whose value is 0 is the *neutral element* — it is what
 * `emptyUsage()` produces — and must not drag a real measurement down with it.
 * Without this carve-out every accumulated total came out `unknown`, because the
 * starting accumulator poisoned the first real value.
 */
export function addUsage(a: UsageReport, b: UsageReport): UsageReport {
  const merge = (x: UsageField, y: UsageField): UsageField => {
    if (x.provenance === 'unknown' && x.value === 0) return { ...y };
    if (y.provenance === 'unknown' && y.value === 0) return { ...x };
    return { value: x.value + y.value, provenance: weakest(x.provenance, y.provenance) };
  };
  return {
    inputTokens: merge(a.inputTokens, b.inputTokens),
    outputTokens: merge(a.outputTokens, b.outputTokens),
    cachedInputTokens: merge(a.cachedInputTokens, b.cachedInputTokens),
    reasoningTokens: merge(a.reasoningTokens, b.reasoningTokens),
  };
}

export function emptyUsage(): UsageReport {
  const none: UsageField = { value: 0, provenance: 'unknown' };
  return {
    inputTokens: { ...none },
    outputTokens: { ...none },
    cachedInputTokens: { ...none },
    reasoningTokens: { ...none },
  };
}

function weakest(a: UsageProvenance, b: UsageProvenance): UsageProvenance {
  const rank: Record<UsageProvenance, number> = { reported: 2, estimated: 1, unknown: 0 };
  return rank[a] <= rank[b] ? a : b;
}

/** One-line rendering for `/status` and the eval summary. */
export function describeUsage(usage: UsageReport, cost: CostEstimate): string {
  const mark = (f: UsageField): string =>
    f.provenance === 'reported' ? `${f.value}` : f.provenance === 'estimated' ? `~${f.value}` : '?';

  const costText =
    cost.provenance === 'unknown' ? 'cost unknown (no pricing configured)' : `$${cost.usd.toFixed(4)}`;

  return (
    `${mark(usage.inputTokens)} in / ${mark(usage.outputTokens)} out` +
    (usage.cachedInputTokens.provenance !== 'unknown' ? ` (${mark(usage.cachedInputTokens)} cached)` : '') +
    (usage.reasoningTokens.provenance !== 'unknown' ? ` (${mark(usage.reasoningTokens)} reasoning)` : '') +
    `, ${costText}`
  );
}
