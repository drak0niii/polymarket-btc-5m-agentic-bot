import type {
  CanonicalEdgeComputation,
  EdgeDefinition,
} from '@polymarket-btc-5m-agentic-bot/domain';

export class EdgeDefinitionService {
  readonly definition: EdgeDefinition = {
    version: 'btc-5m-polymarket-edge-v1',
    predictiveTarget: {
      kind: 'net_executable_ev',
      description:
        'Expected net executable EV for a fee-aware Polymarket order that can be entered and exited inside the configured hold window.',
      targetVariable: 'expected_net_executable_ev',
    },
    forecastHorizon: {
      entryWindowSeconds: 20,
      holdWindowSeconds: 180,
      expiryBufferSeconds: 30,
    },
    executableBenchmark: {
      style: 'hybrid',
      description:
        'Hybrid Polymarket benchmark using taker immediacy when the book is thin and maker-style entry only when modeled non-fill and cancel risk still preserve edge.',
      includesFees: true,
      includesSlippage: true,
      includesTimeoutRisk: true,
      includesStaleSignalRisk: true,
      includesInventoryConstraints: true,
    },
    admissionThresholdPolicy: {
      minimumNetEdge: 0.0025,
      minimumConfidence: 0.35,
      minimumRobustnessScore: 0.55,
      failClosedOnMissingInputs: true,
      rewardsIncludedByDefault: false,
    },
  };

  getDefinition(): EdgeDefinition {
    return this.definition;
  }

  compute(input: {
    posteriorProbability: number;
    marketImpliedProbability: number;
    rawModelEdge: number;
    executableNetEdge: number;
    confidence: number;
  }): CanonicalEdgeComputation {
    return {
      definitionVersion: this.definition.version,
      targetProbability: input.posteriorProbability,
      marketImpliedProbability: input.marketImpliedProbability,
      rawModelEdge: input.rawModelEdge,
      executableNetEdge: input.executableNetEdge,
      confidence: input.confidence,
      computedAt: new Date().toISOString(),
    };
  }
}
