export class MarketResponseDto {
  id!: string;
  slug!: string;
  title!: string;
  status!: string;
  tokenIdYes!: string | null;
  tokenIdNo!: string | null;
  resolutionSource!: string | null;
  expiresAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
