import { phaseTwoNetEdgeTruthPathTests } from './net-edge-truth-path.integration.test';

export const phaseTenNetEdgeRealismTests = [
  {
    name: 'phase10 expected versus realized edge decomposition matches ledger',
    fn: phaseTwoNetEdgeTruthPathTests[1]!.fn,
  },
  {
    name: 'phase10 net-edge realism remains fully decomposed',
    fn: phaseTwoNetEdgeTruthPathTests[0]!.fn,
  },
];
