import type { TransactionManager } from '../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../@shared/gateway/id-generator.gateway';
import { OutboxRepository } from '../../@shared/repository/outbox.repository';
import { LedgerRepository } from '../../wallet/repository/ledger.repository';
import { WalletMovementRepository } from '../../wallet/repository/wallet-movement.repository';
import { WalletRepository } from '../../wallet/repository/wallet.repository';
import { WagerTransactionRepository } from '../repository/wager-transaction.repository';
import { FindWagerTransactionByExternalIdUseCase } from '../usecase/find-wager-transaction-by-external-id/find-wager-transaction-by-external-id.usecase';
import { FindWagerTransactionByIdUseCase } from '../usecase/find-wager-transaction-by-id/find-wager-transaction-by-id.usecase';
import { SubmitWagerTransactionUseCase } from '../usecase/submit-wager-transaction/submit-wager-transaction.usecase';

export interface WageringFactoryDependencies {
  transactions: TransactionManager;
  ids: IdGenerator;
  clock: Clock;
}

export interface WageringUseCases {
  submit: SubmitWagerTransactionUseCase;
  findById: FindWagerTransactionByIdUseCase;
  findByExternalId: FindWagerTransactionByExternalIdUseCase;
}

export const WageringFactory = {
  create(dependencies: WageringFactoryDependencies): WageringUseCases {
    const wagers = new WagerTransactionRepository();
    const outbox = new OutboxRepository();
    return {
      submit: new SubmitWagerTransactionUseCase(
        dependencies.transactions,
        wagers,
        new WalletMovementRepository(
          new WalletRepository(),
          new LedgerRepository(),
          outbox,
        ),
        dependencies.ids,
        dependencies.clock,
        outbox,
      ),
      findById: new FindWagerTransactionByIdUseCase(
        dependencies.transactions,
        wagers,
      ),
      findByExternalId: new FindWagerTransactionByExternalIdUseCase(
        dependencies.transactions,
        wagers,
      ),
    };
  },
};
