import type { ParsedUsage } from "./types";

export interface ModelPricing {
  id: string;
  match: (model: string) => boolean;
  inputUsdPerMillion: number;
  cacheCreationUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface CostEstimate {
  cost_usd: number;
  pricing_model: string | null;
  warnings: string[];
}

// v0 intentionally uses a compact, hardcoded API list-price table, seeded
// from official OpenAI and Anthropic pricing pages checked on 2026-05-06.
// Update this table when provider API pricing changes; exact enterprise or
// harness billing reconciliation is out of scope for v0.
const PRICING_TABLE: ModelPricing[] = [
  {
    id: "gpt-5.4-mini",
    match: exactModel("gpt-5.4-mini"),
    inputUsdPerMillion: 0.75,
    cacheCreationUsdPerMillion: 0.75,
    cacheReadUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5
  },
  {
    id: "gpt-5.4",
    match: exactModel("gpt-5.4"),
    inputUsdPerMillion: 2.5,
    cacheCreationUsdPerMillion: 2.5,
    cacheReadUsdPerMillion: 0.25,
    outputUsdPerMillion: 15
  },
  {
    id: "gpt-5.3-codex",
    match: exactModel("gpt-5.3-codex"),
    inputUsdPerMillion: 1.75,
    cacheCreationUsdPerMillion: 1.75,
    cacheReadUsdPerMillion: 0.175,
    outputUsdPerMillion: 14
  },
  {
    id: "gpt-5-codex",
    match: exactModel("gpt-5-codex"),
    inputUsdPerMillion: 1.25,
    cacheCreationUsdPerMillion: 1.25,
    cacheReadUsdPerMillion: 0.125,
    outputUsdPerMillion: 10
  },
  {
    id: "claude-haiku-4.5",
    match: modelPrefix(["claude-haiku-4-5", "claude-haiku-4.5", "claude-4-5-haiku", "haiku"]),
    inputUsdPerMillion: 1,
    cacheCreationUsdPerMillion: 1.25,
    cacheReadUsdPerMillion: 0.1,
    outputUsdPerMillion: 5
  },
  {
    id: "claude-haiku-3.5",
    match: modelPrefix(["claude-3-5-haiku", "claude-haiku-3-5", "claude-haiku-3.5"]),
    inputUsdPerMillion: 0.8,
    cacheCreationUsdPerMillion: 1,
    cacheReadUsdPerMillion: 0.08,
    outputUsdPerMillion: 4
  },
  {
    id: "claude-sonnet-4",
    match: modelPrefix(["claude-sonnet-4", "claude-4-sonnet"]),
    inputUsdPerMillion: 3,
    cacheCreationUsdPerMillion: 3.75,
    cacheReadUsdPerMillion: 0.3,
    outputUsdPerMillion: 15
  }
] as const;

export function estimateUsageCost(model: string | null, usage: ParsedUsage): CostEstimate {
  if (model === null || model.trim().length === 0) {
    return {
      cost_usd: 0,
      pricing_model: null,
      warnings: ["cannot estimate cost because session model is unknown"]
    };
  }

  const pricing = PRICING_TABLE.find((entry) => entry.match(model));
  if (pricing === undefined) {
    return {
      cost_usd: 0,
      pricing_model: null,
      warnings: [`no v0 pricing entry for model ${model}; stored cost_usd = 0`]
    };
  }

  if (!hasUsageTokens(usage)) {
    return {
      cost_usd: 0,
      pricing_model: pricing.id,
      warnings: [`cannot estimate cost for model ${model} because usage tokens are all zero`]
    };
  }

  const costUsd =
    (usage.input_tokens * pricing.inputUsdPerMillion) / 1_000_000 +
    (usage.cache_creation_tokens * pricing.cacheCreationUsdPerMillion) / 1_000_000 +
    (usage.cache_read_tokens * pricing.cacheReadUsdPerMillion) / 1_000_000 +
    (usage.output_tokens * pricing.outputUsdPerMillion) / 1_000_000;

  return {
    cost_usd: costUsd,
    pricing_model: pricing.id,
    warnings: []
  };
}

function hasUsageTokens(usage: ParsedUsage): boolean {
  return (
    usage.input_tokens > 0 ||
    usage.output_tokens > 0 ||
    usage.cache_read_tokens > 0 ||
    usage.cache_creation_tokens > 0
  );
}

function exactModel(id: string): (model: string) => boolean {
  return (model) => model.toLowerCase() === id;
}

function modelPrefix(prefixes: string[]): (model: string) => boolean {
  return (model) => {
    const normalized = model.toLowerCase();
    return prefixes.some((prefix) => normalized.startsWith(prefix));
  };
}
