import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type { WagerTransaction } from '../domain/wager-transaction.entity';

export interface WagerTransactionGateway {
  create(transaction: WagerTransaction, trx: TransactionContext): Promise<void>;
  findById(
    id: string,
    trx: TransactionContext,
  ): Promise<WagerTransaction | null>;
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
    trx: TransactionContext,
  ): Promise<WagerTransaction | null>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
    trx: TransactionContext,
  ): Promise<WagerTransaction | null>;
}
