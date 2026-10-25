import type { InboxDelivery } from '../../@shared/domain/inbox/inbox-message.entity';
import type { TransactionManager } from '../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../@shared/gateway/id-generator.gateway';
import { InboxMessageRepository } from '../../@shared/repository/inbox-message.repository';
import { OutboxMessageRepository } from '../../@shared/repository/outbox-message.repository';
import { InboxTransactionManager } from '../../@shared/usecase/inbox-transaction-manager';
import { LedgerRepository } from '../../wallet/repository/ledger.repository';
import { WalletMovementRepository } from '../../wallet/repository/wallet-movement.repository';
import { WalletRepository } from '../../wallet/repository/wallet.repository';
import type { PendingReferenceMonitor } from '../gateway/pending-reference-monitor.gateway';
import { WagerTransactionRepository } from '../repository/wager-transaction.repository';
import { FindWagerTransactionByExternalIdUseCase } from '../usecase/find-by-external-id/find-by-external-id.usecase';
import { FindWagerTransactionByIdUseCase } from '../usecase/find-by-id/find-by-id.usecase';
import { ResolvePendingWagerTransactionsUseCase } from '../usecase/resolve-pending/resolve-pending.usecase';
import { SubmitWagerTransactionUseCase } from '../usecase/submit/submit.usecase';
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
  submitFor: (delivery: InboxDelivery) => SubmitWagerTransactionUseCase;
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
    const inbox = new InboxMessageRepository();
    const submitWith = (
      transactions: TransactionManager,
    ): SubmitWagerTransactionUseCase =>
      new SubmitWagerTransactionUseCase(
        transactions,
        wagers,
        wallets,
        dependencies.ids,
        dependencies.clock,
        settlement,
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
      submit: submitWith(dependencies.transactions),
      submitFor: (delivery) =>
        submitWith(
          new InboxTransactionManager(
            dependencies.transactions,
            inbox,
            dependencies.clock,
            delivery,
          ),
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
