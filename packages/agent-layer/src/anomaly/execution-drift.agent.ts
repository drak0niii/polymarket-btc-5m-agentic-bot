import { OpenAiClient } from '../openai-client';

export interface ExecutionDriftInput {
  executionDiagnostics: Record<string, unknown>;
  evDriftDiagnostics?: Record<string, unknown>;
  regimeDiagnostics?: Record<string, unknown>;
}

export interface ExecutionDriftOutput {
  report: Record<string, unknown>;
  generatedAt: string;
}

export class ExecutionDriftAgent {
  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly model: string,
  ) {}

  async run(input: ExecutionDriftInput): Promise<ExecutionDriftOutput> {
    const response = await this.openAiClient.generateStructured<Record<string, unknown>>({
      model: this.model,
      systemPrompt:
        'You are an execution drift reviewer for a live BTC 5-minute Polymarket trading bot. Explain why realized execution quality may be diverging from expected performance in structured form.',
      userPrompt: JSON.stringify(input),
      schemaName: 'execution_drift_report',
    });

    return {
      report: response.output,
      generatedAt: response.receivedAt,
    };
  }
}