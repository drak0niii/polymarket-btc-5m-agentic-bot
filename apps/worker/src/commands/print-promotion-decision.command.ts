import { StrategyDeploymentRegistry } from '@worker/runtime/strategy-deployment-registry';

async function main(): Promise<void> {
  const variantId = process.argv[2] ?? null;
  const deploymentRegistry = new StrategyDeploymentRegistry();
  const registryState = await deploymentRegistry.load();

  process.stdout.write(
    `${JSON.stringify(
      {
        lastPromotionDecision: registryState.lastPromotionDecision,
        activeRollout: registryState.activeRollout,
        lastRollback: registryState.lastRollback,
        variant: variantId ? registryState.variants[variantId] ?? null : null,
        quarantines: Object.values(registryState.quarantines).filter((record) =>
          variantId ? record.scope.variantId === variantId : true,
        ),
      },
      null,
      2,
    )}\n`,
  );
}

void main();
