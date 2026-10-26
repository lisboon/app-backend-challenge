import type { TransactionManager } from '../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../@shared/gateway/id-generator.gateway';
import { OutboxMessageRepository } from '../../@shared/repository/outbox-message.repository';
import { OpeningTransactionRepository } from '../../wagering/repository/opening-transaction.repository';
import { WagerTransactionRepository } from '../../wagering/repository/wager-transaction.repository';
import type { ReconciliationMonitor } from '../gateway/reconciliation-monitor.gateway';
import { LedgerRepository } from '../repository/ledger.repository';
import { WalletRepository } from '../repository/wallet.repository';
import { CreateWalletUseCase } from '../usecase/create/create.usecase';
import { FindWalletByIdUseCase } from '../usecase/find-by-id/find-by-id.usecase';
import { ListWalletLedgerUseCase } from '../usecase/list-ledger/list-ledger.usecase';
import { ReconcileWalletUseCase } from '../usecase/reconcile/reconcile.usecase';

interface WalletFactoryDependencies {
  monitor: ReconciliationMonitor;
  transactions: TransactionManager;
  ids: IdGenerator;
  clock: Clock;
}

export interface WalletUseCases {
  reconcile: ReconcileWalletUseCase;
  listLedger: ListWalletLedgerUseCase;
  create: CreateWalletUseCase;
  findById: FindWalletByIdUseCase;
}

export const WalletFactory = {
  create(dependencies: WalletFactoryDependencies): WalletUseCases {
    const wallets = new WalletRepository();
    const ledger = new LedgerRepository();
    const outbox = new OutboxMessageRepository();
    return {
      reconcile: new ReconcileWalletUseCase(
        dependencies.transactions,
        wallets,
        ledger,
        dependencies.monitor,
      ),
      listLedger: new ListWalletLedgerUseCase(
        dependencies.transactions,
        wallets,
        ledger,
      ),
      create: new CreateWalletUseCase(
        dependencies.transactions,
        wallets,
        ledger,
        new OpeningTransactionRepository(
          new WagerTransactionRepository(),
          outbox,
        ),
        dependencies.ids,
        dependencies.clock,
        outbox,
      ),
      findById: new FindWalletByIdUseCase(dependencies.transactions, wallets),
    };
  },
};
