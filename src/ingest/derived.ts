import type { Database, SQLQueryBindings } from "bun:sqlite";
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

interface SqlRunResult {
  changes: number;
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
    updateUsageCost(db, baseResult.session_id, costEstimate.cost_usd);
    upsertSummary(db, {
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

function updateUsageCost(db: Database, sessionId: string, costUsd: number): void {
  runSql(db, "UPDATE usage SET cost_usd = ? WHERE session_id = ?", [costUsd, sessionId]);
}

function upsertSummary(
  db: Database,
  input: { sessionId: string; summaryMd: string; modelUsed: string; generatedAt: string }
): void {
  runSql(
    db,
    `INSERT INTO summaries (
      session_id,
      summary_md,
      model_used,
      generated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      summary_md = excluded.summary_md,
      model_used = excluded.model_used,
      generated_at = excluded.generated_at`,
    [input.sessionId, input.summaryMd, input.modelUsed, input.generatedAt]
  );
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): number {
  const result = db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params) as SqlRunResult;
  return result.changes;
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
