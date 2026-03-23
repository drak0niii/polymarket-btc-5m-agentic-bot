import { OpenAiClient } from '../openai-client';

export interface StrategyCriticInput {
  strategyProposal: Record<string, unknown>;
  liveConstraints?: Record<string, unknown>;
}

export interface StrategyCriticOutput {
  critique: Record<string, unknown>;
  generatedAt: string;
}

export class StrategyCriticAgent {
  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly model: string,
  ) {}

  async run(input: StrategyCriticInput): Promise<StrategyCriticOutput> {
    const response = await this.openAiClient.generateStructured<Record<string, unknown>>({
      model: this.model,
      systemPrompt:
        'You are a strict strategy critic for a live BTC 5-minute Polymarket trading bot. Reject weak, unsafe, or ambiguous strategy proposals.',
      userPrompt: JSON.stringify(input),
      schemaName: 'strategy_critique',
    });

    return {
      critique: response.output,
      generatedAt: response.receivedAt,
    };
  }
}