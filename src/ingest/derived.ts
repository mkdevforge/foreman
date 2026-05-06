import type { Database } from "bun:sqlite";
import { updateSessionCost, upsertSessionSummary } from "../db/session-writes";
import { ingestParsedSession, type IngestParsedSessionOptions, type IngestParsedSessionResult } from "./common";
import { estimateUsageCost, type CostEstimate } from "./pricing";
import {
  buildSummaryRequest,
  truncateSummaryInput,
  type SummaryProvider,
  type SummaryTruncationOptions,
  type TruncatedSummaryInput
} from "./summarize";
import type { ParsedSession } from "./types";

export interface IngestParsedSessionWithDerivedDataOptions extends IngestParsedSessionOptions {
  summaryProvider: SummaryProvider;
  summaryTruncation?: SummaryTruncationOptions;
}

export interface IngestParsedSessionWithDerivedDataResult extends IngestParsedSessionResult {
  summary_upserted: boolean;
  summary_truncated: boolean;
  summary_elided_chars: number;
  cost_usd: number;
  pricing_model: string | null;
}

export async function ingestParsedSessionWithDerivedData(
  db: Database,
  parsed: ParsedSession,
  options: IngestParsedSessionWithDerivedDataOptions
): Promise<IngestParsedSessionWithDerivedDataResult> {
  const baseResult = ingestParsedSession(db, parsed, options);
  const costEstimate = estimateUsageCost(parsed.model, parsed.usage);
  const truncation = truncateSummaryInput(parsed.summary_input, options.summaryTruncation);
  const summaryRequest = buildSummaryRequest(parsed, truncation);
  const summaryResult = await options.summaryProvider.summarize(summaryRequest);
  const generatedAt = (options.now ?? defaultNow)();

  const writeDerived = db.transaction(() => {
    updateSessionCost(db, baseResult.session_id, costEstimate.cost_usd);
    upsertSessionSummary(db, {
      sessionId: baseResult.session_id,
      summaryMd: summaryResult.summary_md,
      modelUsed: summaryResult.model_used,
      generatedAt
    });
  });
  writeDerived.immediate();

  return {
    ...baseResult,
    summary_upserted: true,
    summary_truncated: truncation.truncated,
    summary_elided_chars: truncation.elided_chars,
    cost_usd: costEstimate.cost_usd,
    pricing_model: costEstimate.pricing_model,
    warnings: mergeWarnings(baseResult.warnings, costEstimate, summaryResult.warnings ?? [])
  };
}

function mergeWarnings(
  baseWarnings: string[],
  costEstimate: CostEstimate,
  summaryWarnings: string[]
): string[] {
  return [...baseWarnings, ...costEstimate.warnings, ...summaryWarnings];
}

function defaultNow(): string {
  return new Date().toISOString();
}
