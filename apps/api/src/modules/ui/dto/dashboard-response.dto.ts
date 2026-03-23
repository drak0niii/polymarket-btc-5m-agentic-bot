export class DashboardResponseDto {
  botState!: unknown;
  readinessDashboard!: unknown;
  markets!: unknown[];
  signals!: unknown[];
  orders!: unknown[];
  portfolio!: unknown | null;
  diagnostics!: {
    execution: unknown[];
    evDrift: unknown[];
    regimes: unknown[];
  };
  activity!: unknown[];
}
