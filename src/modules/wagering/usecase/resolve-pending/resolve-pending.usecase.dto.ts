import type { BaseUseCase } from '../../../@shared/usecase/base.usecase';

export interface ResolvePendingWagerTransactionsUseCaseInputDto {
  limit: number;
}

export interface ResolvePendingWagerTransactionsUseCaseOutputDto {
  attempted: number;
}

export type ResolvePendingWagerTransactionsUseCaseInterface = BaseUseCase<
  ResolvePendingWagerTransactionsUseCaseInputDto,
  ResolvePendingWagerTransactionsUseCaseOutputDto
>;
