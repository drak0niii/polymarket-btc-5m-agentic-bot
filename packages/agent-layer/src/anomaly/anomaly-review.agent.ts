import { OpenAiClient } from '../openai-client';

export interface AnomalyReviewInput {
  anomalyContext: Record<string, unknown>;
  recentDiagnostics?: Record<string, unknown>;
}

export interface AnomalyReviewOutput {
  report: Record<string, unknown>;
  generatedAt: string;
}

export class AnomalyReviewAgent {
  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly model: string,
  ) {}

  async run(input: AnomalyReviewInput): Promise<AnomalyReviewOutput> {
    const response = await this.openAiClient.generateStructured<Record<string, unknown>>({
      model: this.model,
      systemPrompt:
        'You are an anomaly reviewer for a live BTC 5-minute Polymarket trading bot. Explain unusual execution, market, and operational anomalies in structured form.',
      userPrompt: JSON.stringify(input),
      schemaName: 'anomaly_report',
    });

    return {
      report: response.output,
      generatedAt: response.receivedAt,
    };
  }
}