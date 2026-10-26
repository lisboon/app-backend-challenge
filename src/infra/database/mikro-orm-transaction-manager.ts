import { IsolationLevel, type TransactionOptions } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

import { InfrastructureUnavailableError } from '../../modules/@shared/domain/errors/infrastructure.errors';
import {
  TransactionContext,
  type TransactionManager,
} from '../../modules/@shared/domain/transaction/transaction-manager';
import {
  isTransientFailure,
  type LockConflictReason,
  lockConflictReason,
} from './database-errors';

const LOCK_TIMEOUT = "set local lock_timeout = '2s'";

export interface LockConflictMonitor {
  conflict(reason: LockConflictReason): void;
}

const UNOBSERVED: LockConflictMonitor = { conflict: () => undefined };

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
  constructor(
    private readonly orm: MikroORM,
    private readonly conflicts: LockConflictMonitor = UNOBSERVED,
  ) {}

  async execute<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T> {
    return this.run(work, { isolationLevel: IsolationLevel.READ_COMMITTED });
  }

  snapshot<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T> {
    return this.run(work, {
      isolationLevel: IsolationLevel.REPEATABLE_READ,
      readOnly: true,
    });
  }

  private async run<T>(
    work: (trx: TransactionContext) => Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(LOCK_TIMEOUT);
        return work(new MikroOrmTransactionContext(em));
      }, options);
    } catch (error) {
      const conflict = lockConflictReason(error);
      if (conflict) {
        this.conflicts.conflict(conflict);
      }
      if (isTransientFailure(error)) {
        throw new InfrastructureUnavailableError('PostgreSQL');
      }
      throw error;
    }
  }
}
