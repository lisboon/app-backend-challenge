import type { BaseUseCase } from '../../../@shared/usecase/base.usecase';
import type { WagerTransactionOutputDto } from '../wager-transaction.output.dto';

export interface FindWagerTransactionByExternalIdUseCaseInputDto {
  providerId: string;
  externalTransactionId: string;
}

export type FindWagerTransactionByExternalIdUseCaseOutputDto =
  WagerTransactionOutputDto;

export type FindWagerTransactionByExternalIdUseCaseInterface = BaseUseCase<
  FindWagerTransactionByExternalIdUseCaseInputDto,
  FindWagerTransactionByExternalIdUseCaseOutputDto
>;
