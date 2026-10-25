import type { TransactionManager } from '../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../@shared/gateway/id-generator.gateway';
import { OutboxMessageRepository } from '../../@shared/repository/outbox-message.repository';
import { LedgerRepository } from '../../wallet/repository/ledger.repository';
import { WalletMovementRepository } from '../../wallet/repository/wallet-movement.repository';
import { WalletRepository } from '../../wallet/repository/wallet.repository';
import type { PendingReferenceMonitor } from '../gateway/pending-reference-monitor.gateway';
import { WagerTransactionRepository } from '../repository/wager-transaction.repository';
import { FindWagerTransactionByExternalIdUseCase } from '../usecase/find-wager-transaction-by-external-id/find-wager-transaction-by-external-id.usecase';
import { FindWagerTransactionByIdUseCase } from '../usecase/find-wager-transaction-by-id/find-wager-transaction-by-id.usecase';
import { ResolvePendingWagerTransactionsUseCase } from '../usecase/resolve-pending-wager-transactions/resolve-pending-wager-transactions.usecase';
import { SubmitWagerTransactionUseCase } from '../usecase/submit-wager-transaction/submit-wager-transaction.usecase';
import { WagerTransactionSettlement } from '../usecase/wager-transaction-settlement';

export interface WageringFactoryDependencies {
  transactions: TransactionManager;
  ids: IdGenerator;
  clock: Clock;
  pendingMonitor: PendingReferenceMonitor;
  pendingReferenceTtlSeconds: number;
}

export interface WageringUseCases {
  submit: SubmitWagerTransactionUseCase;
  findById: FindWagerTransactionByIdUseCase;
  findByExternalId: FindWagerTransactionByExternalIdUseCase;
  resolvePending: ResolvePendingWagerTransactionsUseCase;
}

export const WageringFactory = {
  create(dependencies: WageringFactoryDependencies): WageringUseCases {
    const wagers = new WagerTransactionRepository();
    const outbox = new OutboxMessageRepository();
    const settlement = new WagerTransactionSettlement(
      wagers,
      dependencies.ids,
      dependencies.clock,
      outbox,
      dependencies.pendingReferenceTtlSeconds,
    );
    const wallets = new WalletMovementRepository(
      new WalletRepository(),
      new LedgerRepository(),
      outbox,
    );
    return {
      resolvePending: new ResolvePendingWagerTransactionsUseCase(
        dependencies.transactions,
        wagers,
        wallets,
        settlement,
        dependencies.clock,
        dependencies.pendingMonitor,
      ),
      submit: new SubmitWagerTransactionUseCase(
        dependencies.transactions,
        wagers,
        wallets,
        dependencies.ids,
        dependencies.clock,
        settlement,
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
