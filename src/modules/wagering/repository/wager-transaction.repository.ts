import { entityManagerOf } from '../../../infra/database/mikro-orm-transaction-manager';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type { WagerTransaction } from '../domain/wager-transaction.entity';
import type { WagerTransactionGateway } from '../gateway/wager-transaction.gateway';
import { WagerTransactionModel } from './wager-transaction.model';

export class WagerTransactionRepository implements WagerTransactionGateway {
  async create(
    transaction: WagerTransaction,
    trx: TransactionContext,
  ): Promise<void> {
    await entityManagerOf(trx).insert(WagerTransactionModel, {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      currency: transaction.money.currency,
      roundId: transaction.roundId ?? null,
      gameId: transaction.gameId ?? null,
      kind: transaction.kind,
      amount: transaction.money.toString(),
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: transaction.status,
      failureCode: null,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt ?? null,
    });
  }
}
