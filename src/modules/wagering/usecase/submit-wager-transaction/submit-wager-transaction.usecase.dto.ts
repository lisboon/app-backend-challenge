import type { FailureCode } from '../../../@shared/domain/failure-code';
import type { MoneyProps } from '../../../@shared/domain/money';
import type { BaseUseCase } from '../../../@shared/usecase/base.usecase';
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.entity';

export interface SubmitWagerTransactionUseCaseInputDto {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export interface SubmitWagerTransactionUseCaseOutputDto {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  balance: MoneyProps | null;
  idempotentReplay: boolean;
}

export type SubmitWagerTransactionUseCaseInterface = BaseUseCase<
  SubmitWagerTransactionUseCaseInputDto,
  SubmitWagerTransactionUseCaseOutputDto
>;
