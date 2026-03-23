import type {
  HealthLabel,
  RegimePerformanceSnapshot,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface EdgeDecayAssessment {
  key: string;
  health: HealthLabel;
  reasons: string[];
  sampleCount: number;
}

export class EdgeDecayDetector {
  assess(snapshot: RegimePerformanceSnapshot): EdgeDecayAssessment {
    const reasons: string[] = [];

    if (snapshot.sampleCount < 3) {
      return {
        key: snapshot.key,
        health: 'healthy',
        reasons: ['insufficient_sample_for_decay'],
        sampleCount: snapshot.sampleCount,
      };
    }

    const ratio = snapshot.realizedVsExpected;
    const underperforming = snapshot.avgRealizedEv < 0 && snapshot.avgExpectedEv > 0;
    const weakWinRate = snapshot.winRate < 0.45;

    if (snapshot.sampleCount >= 8 && (ratio <= 0.15 || (underperforming && weakWinRate))) {
      reasons.push('persistent_realized_edge_collapse');
      return {
        key: snapshot.key,
        health: 'quarantine_candidate',
        reasons,
        sampleCount: snapshot.sampleCount,
      };
    }

    if (snapshot.sampleCount >= 5 && (ratio <= 0.4 || underperforming)) {
      reasons.push('multi_sample_edge_underperformance');
      return {
        key: snapshot.key,
        health: 'degraded',
        reasons,
        sampleCount: snapshot.sampleCount,
      };
    }

    if (ratio <= 0.75 || weakWinRate || snapshot.avgFillRate < 0.5) {
      reasons.push('early_edge_softening');
      return {
        key: snapshot.key,
        health: 'watch',
        reasons,
        sampleCount: snapshot.sampleCount,
      };
    }

    reasons.push('edge_within_expected_band');
    return {
      key: snapshot.key,
      health: 'healthy',
      reasons,
      sampleCount: snapshot.sampleCount,
    };
  }

  assessAll(
    snapshots: RegimePerformanceSnapshot[],
  ): Array<RegimePerformanceSnapshot & { decayReasons: string[] }> {
    return snapshots.map((snapshot) => {
      const assessment = this.assess(snapshot);
      return {
        ...snapshot,
        health: assessment.health,
        decayReasons: assessment.reasons,
      };
    });
  }
}
