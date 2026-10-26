import type { BaseUseCase } from '../../../@shared/usecase/base.usecase';
import type { SubmitWagerTransactionUseCaseInputDto } from '../submit/submit.usecase.dto';

export type RecordFailedWagerTransactionUseCaseInputDto =
  SubmitWagerTransactionUseCaseInputDto;

export interface RecordFailedWagerTransactionUseCaseOutputDto {
  transactionId: string | null;
}

export type RecordFailedWagerTransactionUseCaseInterface = BaseUseCase<
  RecordFailedWagerTransactionUseCaseInputDto,
  RecordFailedWagerTransactionUseCaseOutputDto
>;
