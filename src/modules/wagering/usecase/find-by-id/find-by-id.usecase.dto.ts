import type { BaseUseCase } from '../../../@shared/usecase/base.usecase';
import type { WagerTransactionOutputDto } from '../wager-transaction.output.dto';

export interface FindWagerTransactionByIdUseCaseInputDto {
  id: string;
}

export type FindWagerTransactionByIdUseCaseOutputDto =
  WagerTransactionOutputDto;

export type FindWagerTransactionByIdUseCaseInterface = BaseUseCase<
  FindWagerTransactionByIdUseCaseInputDto,
  FindWagerTransactionByIdUseCaseOutputDto
>;
