import { isUniqueViolation } from '../../../infra/database/database-errors';
import { entityManagerOf } from '../../../infra/database/mikro-orm-transaction-manager';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import {
  ExternalTransactionConflictError,
  IdempotencyRaceError,
  ReferenceAlreadyReversedError,
} from '../domain/errors/wagering.errors';
import type { WagerTransaction } from '../domain/wager-transaction.entity';
import type { WagerTransactionGateway } from '../gateway/wager-transaction.gateway';
import { WagerTransactionModel } from './wager-transaction.model';
import {
  WagerTransactionModelMapper,
  type WagerTransactionRow,
} from './wager-transaction.model.mapper';

const ONE_TRANSACTION_PER_IDEMPOTENCY_KEY = 'wager_tx_idempotency_uk';
const ONE_TRANSACTION_PER_EXTERNAL_ID = 'wager_tx_external_uk';

export class WagerTransactionRepository implements WagerTransactionGateway {
  async create(
    transaction: WagerTransaction,
    trx: TransactionContext,
  ): Promise<void> {
    try {
      await entityManagerOf(trx).insert(
        WagerTransactionModel,
        WagerTransactionModelMapper.toModel(transaction),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'wager_tx_single_reversal_uk')) {
        throw new ReferenceAlreadyReversedError();
      }
      if (isUniqueViolation(error, ONE_TRANSACTION_PER_IDEMPOTENCY_KEY)) {
        throw new IdempotencyRaceError();
      }
      if (isUniqueViolation(error, ONE_TRANSACTION_PER_EXTERNAL_ID)) {
        throw new ExternalTransactionConflictError();
      }
      throw error;
    }
  }

  async update(
    transaction: WagerTransaction,
    trx: TransactionContext,
  ): Promise<void> {
    try {
      await entityManagerOf(trx).nativeUpdate(
        WagerTransactionModel,
        { id: transaction.id },
        WagerTransactionModelMapper.toModel(transaction),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'wager_tx_single_reversal_uk')) {
        throw new ReferenceAlreadyReversedError();
      }
      throw error;
    }
  }

  findDueReferences(
    now: Date,
    limit: number,
    trx: TransactionContext,
  ): Promise<{ id: string; walletId: string }[]> {
    return entityManagerOf(trx).execute(
      'select id, wallet_id as "walletId" from wager_transactions where status=\'PENDING_REFERENCE\' and next_reference_attempt_at<=? order by next_reference_attempt_at,id limit ?',
      [now, limit],
    );
  }

  async lockPendingReference(
    id: string,
    trx: TransactionContext,
  ): Promise<WagerTransaction | null> {
    const rows = await entityManagerOf(trx).execute<{ id: string }[]>(
      "select id from wager_transactions where id=? and status='PENDING_REFERENCE' for update skip locked",
      [id],
    );
    return rows.length === 0 ? null : this.findById(id, trx);
  }

  async findReversals(
    referenceId: string,
    trx: TransactionContext,
  ): Promise<WagerTransaction[]> {
    const em = entityManagerOf(trx);
    const rows = await em.execute<{ id: string }[]>(
      "select id from wager_transactions where status='PROCESSED' and (reference_transaction_id=? or reference_transaction_id in (select id from wager_transactions where reference_transaction_id=? and kind='REFUND' and status='PROCESSED'))",
      [referenceId, referenceId],
    );
    if (rows.length === 0) {
      return [];
    }
    const models = await em.find(WagerTransactionModel, {
      id: { $in: rows.map((row) => row.id) },
    });
    return models.map((model) => WagerTransactionModelMapper.toEntity(model));
  }

  async accelerateReferences(
    transaction: WagerTransaction,
    at: Date,
    trx: TransactionContext,
  ): Promise<void> {
    await entityManagerOf(trx).nativeUpdate(
      WagerTransactionModel,
      {
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        referenceExternalTransactionId: transaction.externalTransactionId,
        status: 'PENDING_REFERENCE',
      },
      { nextReferenceAttemptAt: at },
    );
  }

  async countPending(trx: TransactionContext): Promise<number> {
    const [row] = await entityManagerOf(trx).execute<{ n: string }[]>(
      "select count(*)::text as n from wager_transactions where status='PENDING_REFERENCE'",
    );
    return Number(row.n);
  }

  findById(
    id: string,
    trx: TransactionContext,
  ): Promise<WagerTransaction | null> {
    return this.findOne({ id }, trx);
  }

  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
    trx: TransactionContext,
  ): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, idempotencyKey }, trx);
  }

  findByExternalId(
    providerId: string,
    externalTransactionId: string,
    trx: TransactionContext,
  ): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, externalTransactionId }, trx);
  }

  private async findOne(
    where: Partial<WagerTransactionRow>,
    trx: TransactionContext,
  ): Promise<WagerTransaction | null> {
    const row = await entityManagerOf(trx).findOne(
      WagerTransactionModel,
      where,
    );
    return row ? WagerTransactionModelMapper.toEntity(row) : null;
  }
}
