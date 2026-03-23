import { OpenAiClient } from '../openai-client';

export interface DailyReviewInput {
  summary: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}

export interface DailyReviewOutput {
  review: Record<string, unknown>;
  generatedAt: string;
}

export class DailyReviewAgent {
  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly model: string,
  ) {}

  async run(input: DailyReviewInput): Promise<DailyReviewOutput> {
    const response = await this.openAiClient.generateStructured<Record<string, unknown>>({
      model: this.model,
      systemPrompt:
        'You are a daily reviewer for a live BTC 5-minute Polymarket trading bot. Summarize performance, risk, execution quality, and operational issues in structured form.',
      userPrompt: JSON.stringify(input),
      schemaName: 'daily_review',
    });

    return {
      review: response.output,
      generatedAt: response.receivedAt,
    };
  }
}