import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

import { InfrastructureUnavailableError } from '../../modules/@shared/domain/errors/infrastructure.errors';
import {
  TransactionContext,
  type TransactionManager,
} from '../../modules/@shared/domain/transaction/transaction-manager';
import { isConnectionFailure } from './database-errors';

export class MikroOrmTransactionContext extends TransactionContext {
  constructor(readonly em: EntityManager) {
    super();
  }
}

export function entityManagerOf(trx: TransactionContext): EntityManager {
  if (trx instanceof MikroOrmTransactionContext) {
    return trx.em;
  }
  throw new Error('contexto de transação não pertence ao MikroORM');
}

export class MikroOrmTransactionManager implements TransactionManager {
  constructor(private readonly orm: MikroORM) {}

  async execute<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em
        .fork()
        .transactional((em) => work(new MikroOrmTransactionContext(em)), {
          isolationLevel: IsolationLevel.READ_COMMITTED,
        });
    } catch (error) {
      if (isConnectionFailure(error)) {
        throw new InfrastructureUnavailableError('PostgreSQL');
      }
      throw error;
    }
  }
}
