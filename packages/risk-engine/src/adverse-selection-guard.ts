export interface AdverseSelectionGuardInput {
  edgeAtSignal: number | null;
  edgeAtFill: number | null;
  maxAllowedDecay: number;
}

export interface AdverseSelectionGuardResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
  decay: number | null;
}

export class AdverseSelectionGuard {
  evaluate(input: AdverseSelectionGuardInput): AdverseSelectionGuardResult {
    if (input.edgeAtSignal === null || input.edgeAtFill === null) {
      return {
        passed: false,
        reasonCode: 'missing_edge_context',
        reasonMessage: 'Edge at signal or edge at fill is missing.',
        decay: null,
      };
    }

    const decay = input.edgeAtSignal - input.edgeAtFill;

    if (decay > input.maxAllowedDecay) {
      return {
        passed: false,
        reasonCode: 'adverse_selection_detected',
        reasonMessage: `Edge decay ${decay} exceeds maximum allowed ${input.maxAllowedDecay}.`,
        decay,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
      decay,
    };
  }
}