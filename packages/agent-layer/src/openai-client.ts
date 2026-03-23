export interface OpenAiStructuredResponse<T> {
  model: string;
  output: T;
  receivedAt: string;
}

export class OpenAiClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async generateStructured<T>(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    schemaName: string;
  }): Promise<OpenAiStructuredResponse<T>> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error('OpenAI client error: API key is required.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: params.model,
          temperature: 0,
          response_format: {
            type: 'json_object',
          },
          messages: [
            {
              role: 'system',
              content: `${params.systemPrompt}\nReturn JSON only. Schema name: ${params.schemaName}.`,
            },
            {
              role: 'user',
              content: params.userPrompt,
            },
          ],
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(
        `OpenAI client error: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    const content = payload.choices?.[0]?.message?.content ?? '{}';
    let output: T;
    try {
      output = this.parseStructuredContent<T>(content);
    } catch {
      throw new Error('OpenAI client error: response content is not valid JSON.');
    }

    return {
      model: payload.model ?? params.model,
      output,
      receivedAt: new Date().toISOString(),
    };
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private parseStructuredContent<T>(content: string): T {
    try {
      return JSON.parse(content) as T;
    } catch {
      const fencedJsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/i);
      if (fencedJsonMatch && fencedJsonMatch[1]) {
        return JSON.parse(fencedJsonMatch[1]) as T;
      }

      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const candidate = content.slice(firstBrace, lastBrace + 1);
        return JSON.parse(candidate) as T;
      }

      throw new Error('No JSON object found in content.');
    }
  }
}
