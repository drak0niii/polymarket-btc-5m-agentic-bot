export interface SceneDistrictContract {
  id: string;
  label: string;
}

export interface SceneStateContract {
  markets: unknown[];
  signals: unknown[];
  orders: unknown[];
  portfolio: unknown | null;
}

export interface SceneContract {
  botState: unknown;
  scene: {
    districts: SceneDistrictContract[];
    state: SceneStateContract;
  };
}