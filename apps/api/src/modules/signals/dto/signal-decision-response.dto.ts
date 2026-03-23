export class SignalDecisionResponseDto {
  id!: string;
  signalId!: string;
  verdict!: string;
  reasonCode!: string;
  reasonMessage!: string | null;
  expectedEv!: number | null;
  positionSize!: number | null;
  decisionAt!: Date;
  createdAt!: Date;
}