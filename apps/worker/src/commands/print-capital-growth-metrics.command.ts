import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import {
  CapitalRampPolicyService,
  EvidenceQualitySizer,
  LiveTrustScore,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { readLatestCapitalGrowthReport } from '@worker/jobs/capitalGrowthReview.job';
import { ResolvedTradeLedger } from '@worker/runtime/resolved-trade-ledger';

export function formatCapitalGrowthMetricsOutput(input: {
  report: Awaited<ReturnType<typeof readLatestCapitalGrowthReport>>;
  resolvedTrades: ResolvedTradeRecord[];
}) {
  const trustScorer = new LiveTrustScore();
  const evidenceSizer = new EvidenceQualitySizer();
  const capitalRampPolicy = new CapitalRampPolicyService();

  const contexts = Array.from(
    new Map(
      input.resolvedTrades
        .filter(
          (trade) => trade.strategyVariantId != null || trade.regime != null,
        )
        .map((trade) => [
          `${trade.strategyVariantId ?? 'unknown'}|${trade.regime ?? 'unknown'}`,
          {
            strategyVariantId: trade.strategyVariantId,
            regime: trade.regime,
          },
        ]),
    ).values(),
  )
    .map((context) => {
      const trust = trustScorer.evaluate({
        strategyVariantId: context.strategyVariantId,
        regime: context.regime,
        resolvedTrades: input.resolvedTrades,
      });
      const evidence = evidenceSizer.evaluate({ trust });
      return {
        strategyVariantId: context.strategyVariantId,
        regime: context.regime,
        trustScore: trust.trustScore,
        componentBreakdown: trust.componentBreakdown,
        recentEvidenceBand: evidence.recentEvidenceBand,
        evidenceFactor: evidence.evidenceFactor,
        sizeClampReasons: evidence.rationale,
        benchmarkRelativeClampStatus:
          trust.componentBreakdown.benchmarkOutperformance < 0.5
            ? 'clamped'
            : 'not_clamped',
        benchmarkOutperformanceComponent:
          trust.componentBreakdown.benchmarkOutperformance,
      };
    })
    .sort((left, right) => left.trustScore - right.trustScore);

  const overallTrust = trustScorer.evaluate({
    strategyVariantId: null,
    regime: null,
    resolvedTrades: input.resolvedTrades,
  });
  const overallEvidence = evidenceSizer.evaluate({ trust: overallTrust });
  const promotionScore =
    input.report?.variants.reduce(
      (best, variant) =>
        Math.max(best, variant.metrics.stabilityAdjustedCapitalGrowthScore),
      0,
    ) ?? 0;
  const capitalRampEligibility = capitalRampPolicy.evaluate({
    tierAllowsScale: true,
    robustnessPassed: input.report?.liveProofScorecard?.promotableEvidence ?? false,
    chaosPassed: true,
    auditCoverageHealthy: true,
    attributionCoverage: Math.min(1, input.resolvedTrades.length / 20),
    promotionScore,
    capitalExposureValidated: true,
    currentTrustLevel: overallTrust.trustScore,
    liveTradeCount: overallTrust.sampleCount,
    benchmarkOutperformanceScore:
      overallTrust.componentBreakdown.benchmarkOutperformance,
    reconciliationCleanliness:
      overallTrust.componentBreakdown.reconciliationCleanliness,
  });

  return {
    report: input.report,
    overallTrustScore: {
      trustScore: overallTrust.trustScore,
      componentBreakdown: overallTrust.componentBreakdown,
      reasonCodes: overallTrust.reasonCodes,
    },
    recentEvidenceBand: overallEvidence.recentEvidenceBand,
    sizeClampReasons: overallEvidence.rationale,
    benchmarkRelativeClampStatus:
      overallTrust.componentBreakdown.benchmarkOutperformance < 0.5
        ? 'clamped'
        : 'not_clamped',
    capitalRampEligibility,
    trustByStrategyRegime: contexts,
  };
}

async function main(): Promise<void> {
  const variantId = process.argv[2] ?? null;
  const report = await readLatestCapitalGrowthReport();
  const resolvedTrades = await new ResolvedTradeLedger().loadRecent(400);
  const output = formatCapitalGrowthMetricsOutput({
    report,
    resolvedTrades,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ...output,
        trustByStrategyRegime:
          variantId == null
            ? output.trustByStrategyRegime
            : output.trustByStrategyRegime.filter(
                (entry) => entry.strategyVariantId === variantId,
              ),
      },
      null,
      2,
    )}\n`,
  );
}

void main();
