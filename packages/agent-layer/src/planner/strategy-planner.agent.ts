import { OpenAiClient } from '../openai-client';

export interface StrategyPlannerInput {
  task: string;
  currentStrategyConfig?: Record<string, unknown>;
}

export interface StrategyPlannerOutput {
  proposal: Record<string, unknown>;
  generatedAt: string;
}

export class StrategyPlannerAgent {
  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly model: string,
  ) {}

  async run(input: StrategyPlannerInput): Promise<StrategyPlannerOutput> {
    const response = await this.openAiClient.generateStructured<Record<string, unknown>>({
      model: this.model,
      systemPrompt:
        'You are a strategy planner for a live BTC 5-minute Polymarket trading bot. Produce structured strategy proposals only.',
      userPrompt: JSON.stringify(input),
      schemaName: 'strategy_proposal',
    });

    return {
      proposal: response.output,
      generatedAt: response.receivedAt,
    };
  }
}