import { Money } from '../../@shared/domain/money';
import { WagerTransaction } from '../domain/wager-transaction.entity';
import type { SubmitWagerTransactionUseCaseInputDto } from './submit/submit.usecase.dto';

export function wagerTransactionCandidate(
  input: SubmitWagerTransactionUseCaseInputDto,
  id: string,
  at: Date,
): WagerTransaction {
  return WagerTransaction.create({
    id,
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    idempotencyKey: input.idempotencyKey,
    walletId: input.walletId,
    playerId: input.playerId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: Money.from(input.money),
    at,
    correlationId: input.correlationId,
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  });
}
