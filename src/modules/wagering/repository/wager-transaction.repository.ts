import { isUniqueViolation } from '../../../infra/database/database-errors';
import { entityManagerOf } from '../../../infra/database/mikro-orm-transaction-manager';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import {
  ExternalTransactionConflictError,
  IdempotencyRaceError,
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
      if (isUniqueViolation(error, ONE_TRANSACTION_PER_IDEMPOTENCY_KEY)) {
        throw new IdempotencyRaceError();
      }
      if (isUniqueViolation(error, ONE_TRANSACTION_PER_EXTERNAL_ID)) {
        throw new ExternalTransactionConflictError();
      }
      throw error;
    }
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
