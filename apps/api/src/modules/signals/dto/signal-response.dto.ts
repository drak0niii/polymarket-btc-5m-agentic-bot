export class SignalResponseDto {
  id!: string;
  marketId!: string;
  strategyVersionId!: string | null;
  side!: string;
  priorProbability!: number;
  posteriorProbability!: number;
  marketImpliedProb!: number;
  edge!: number;
  expectedEv!: number;
  regime!: string | null;
  status!: string;
  observedAt!: Date;
  createdAt!: Date;
}