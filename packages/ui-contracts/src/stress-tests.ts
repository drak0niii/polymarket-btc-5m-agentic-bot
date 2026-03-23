export interface StressTestRunContract {
  id: string;
  family: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  summary: Record<string, unknown> | null;
  verdict: string | null;
  createdAt: string;
}

export interface StressTestScenarioResultContract {
  id: string;
  stressTestRunId: string;
  scenarioKey: string;
  status: string;
  verdict: string | null;
  parameters: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  createdAt: string;
}