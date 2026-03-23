export class SceneResponseDto {
  botState!: unknown;
  scene!: {
    districts: Array<{
      id: string;
      label: string;
    }>;
    state: {
      markets: unknown[];
      signals: unknown[];
      orders: unknown[];
      portfolio: unknown | null;
    };
  };
}