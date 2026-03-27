import { StrategyDeploymentRegistry } from '@worker/runtime/strategy-deployment-registry';

export function formatPromotionDecisionOutput(input: {
  variantId: string | null;
  registryState: Awaited<ReturnType<StrategyDeploymentRegistry['load']>>;
}): Record<string, unknown> {
  const variant =
    input.variantId == null ? null : input.registryState.variants[input.variantId] ?? null;
  const promotionDecision = input.registryState.lastPromotionDecision;
  const evidence =
    promotionDecision?.evidence && typeof promotionDecision.evidence === 'object'
      ? (promotionDecision.evidence as Record<string, unknown>)
      : null;
  const liveEvidencePacket =
    evidence?.liveEvidencePacket && typeof evidence.liveEvidencePacket === 'object'
      ? (evidence.liveEvidencePacket as Record<string, unknown>)
      : null;
  const livePromotionGate =
    evidence?.livePromotionGate && typeof evidence.livePromotionGate === 'object'
      ? (evidence.livePromotionGate as Record<string, unknown>)
      : null;
  const liveDemotionGate =
    evidence?.liveDemotionGate && typeof evidence.liveDemotionGate === 'object'
      ? (evidence.liveDemotionGate as Record<string, unknown>)
      : null;

  return {
    currentDeploymentTier: variant?.rolloutStage ?? null,
    currentStatus: variant?.status ?? null,
    liveTrustScore: variant?.liveTrustScore ?? null,
    evidenceWindow: {
      start: variant?.evidenceWindowStart ?? liveEvidencePacket?.evidenceWindowStart ?? null,
      end: variant?.evidenceWindowEnd ?? liveEvidencePacket?.evidenceWindowEnd ?? null,
    },
    promotionOrDemotionDecision: promotionDecision?.verdict ?? null,
    explicitReasonCodes: promotionDecision?.reasons ?? [],
    quarantineOrProbationStatus:
      variant?.status === 'probation' || variant?.status === 'quarantined'
        ? {
            status: variant.status,
            quarantineUntil: variant.quarantineUntil ?? null,
            demotionReasonCodes: variant.demotionReasonCodes ?? [],
          }
        : null,
    livePromotionGate,
    liveDemotionGate,
    liveEvidencePacket,
    activeRollout: input.registryState.activeRollout,
    lastRollback: input.registryState.lastRollback,
    variant,
  };
}

async function main(): Promise<void> {
  const variantId = process.argv[2] ?? null;
  const deploymentRegistry = new StrategyDeploymentRegistry();
  const registryState = await deploymentRegistry.load();
  process.stdout.write(
    `${JSON.stringify(
      formatPromotionDecisionOutput({
        variantId,
        registryState,
      }),
      null,
      2,
    )}\n`,
  );
}

void main();
