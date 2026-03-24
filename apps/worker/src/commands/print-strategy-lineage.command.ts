import { StrategyDeploymentRegistry } from '@worker/runtime/strategy-deployment-registry';
import { VersionLineageRegistry } from '@worker/runtime/version-lineage-registry';

async function main(): Promise<void> {
  const variantId = process.argv[2] ?? null;
  const deploymentRegistry = new StrategyDeploymentRegistry();
  const versionLineageRegistry = new VersionLineageRegistry();

  const [registryState, latestDecisions] = await Promise.all([
    deploymentRegistry.load(),
    variantId
      ? versionLineageRegistry.getLatestForStrategyVariant(variantId, 20)
      : versionLineageRegistry.getLatestDecisions(20),
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        incumbentVariantId: registryState.incumbentVariantId,
        activeRollout: registryState.activeRollout,
        variant: variantId ? registryState.variants[variantId] ?? null : null,
        variants: variantId ? undefined : registryState.variants,
        recentLineageDecisions: latestDecisions,
      },
      null,
      2,
    )}\n`,
  );
}

void main();
