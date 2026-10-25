import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type { WagerTransaction } from '../domain/wager-transaction.entity';

export interface WagerTransactionGateway {
  create(transaction: WagerTransaction, trx: TransactionContext): Promise<void>;
  update(transaction: WagerTransaction, trx: TransactionContext): Promise<void>;
  findDueReferences(
    now: Date,
    limit: number,
    trx: TransactionContext,
  ): Promise<{ id: string; walletId: string }[]>;
  lockPendingReference(
    id: string,
    trx: TransactionContext,
  ): Promise<WagerTransaction | null>;
  findReversals(
    referenceId: string,
    trx: TransactionContext,
  ): Promise<WagerTransaction[]>;
  accelerateReferences(
    transaction: WagerTransaction,
    at: Date,
    trx: TransactionContext,
  ): Promise<void>;
  countPending(trx: TransactionContext): Promise<number>;
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
