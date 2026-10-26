import { DomainError } from '../../../@shared/domain/errors/domain.error';
import { WalletNotFoundError } from '../../../@shared/domain/errors/wallet-not-found.error';
import { FailureCode, FailureKind } from '../../../@shared/domain/failure-code';
import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../../@shared/gateway/clock.gateway';
import {
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../domain/wager-transaction.entity';
import type {
  PendingReferenceMonitor,
  PendingReferenceOutcome,
} from '../../gateway/pending-reference-monitor.gateway';
import type { WagerTransactionMonitor } from '../../gateway/wager-transaction-monitor.gateway';
import type {
  PendingWagerTransaction,
  WagerTransactionGateway,
} from '../../gateway/wager-transaction.gateway';
import type { WalletMovementGateway } from '../../gateway/wallet-movement.gateway';
import type { WagerTransactionSettlement } from '../wager-transaction-settlement';
import type {
  ResolvePendingWagerTransactionsUseCaseInputDto,
  ResolvePendingWagerTransactionsUseCaseOutputDto,
  ResolvePendingWagerTransactionsUseCaseInterface,
} from './resolve-pending.usecase.dto';

export class ResolvePendingWagerTransactionsUseCase implements ResolvePendingWagerTransactionsUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly wagers: WagerTransactionGateway,
    private readonly wallets: WalletMovementGateway,
    private readonly settlement: WagerTransactionSettlement,
    private readonly clock: Clock,
    private readonly monitor: PendingReferenceMonitor,
    private readonly wagerMonitor: WagerTransactionMonitor,
  ) {}

  async execute(
    input: ResolvePendingWagerTransactionsUseCaseInputDto,
  ): Promise<ResolvePendingWagerTransactionsUseCaseOutputDto> {
    const candidates = await this.transactions.snapshot((trx) =>
      this.wagers.findDueReferences(this.clock.now(), input.limit, trx),
    );
    let attempted = 0;
    for (const candidate of candidates) {
      attempted += await this.resolve(candidate);
    }
    const pending = await this.transactions.snapshot((trx) =>
      this.wagers.countPending(trx),
    );
    this.monitor.pending(pending);
    return { attempted };
  }

  private async resolve(candidate: PendingWagerTransaction): Promise<number> {
    try {
      const transaction = await this.transactions.execute(async (trx) => {
        const wallet = await this.wallets.lock(candidate.walletId, trx);
        if (!wallet) {
          throw new WalletNotFoundError();
        }
        const pending = await this.wagers.lockPendingReference(
          candidate.id,
          trx,
        );
        if (!pending || !pending.isReferenceDue(this.clock.now())) {
          return null;
        }
        await this.settlement.apply(pending, wallet, trx);
        await this.wagers.update(pending, trx);
        return pending;
      });
      if (!transaction) {
        return 0;
      }
      this.record(transaction);
      return 1;
    } catch (error) {
      this.monitor.failed(candidate, error);
      return this.afterFailure(candidate, isInternal(error));
    }
  }

  private async afterFailure(
    candidate: PendingWagerTransaction,
    internal: boolean,
  ): Promise<number> {
    try {
      const transaction = await this.transactions.execute(async (trx) => {
        const wallet = await this.wallets.lock(candidate.walletId, trx);
        if (!wallet) {
          return null;
        }
        const pending = await this.wagers.lockPendingReference(
          candidate.id,
          trx,
        );
        const now = this.clock.now();
        if (!pending || !pending.isReferenceDue(now)) {
          return null;
        }
        if (internal) {
          pending.fail(FailureCode.PROCESSING_FAILED, now);
        } else {
          pending.scheduleReferenceRetry(now);
        }
        await this.wagers.update(pending, trx);
        return pending;
      });
      if (!transaction) {
        return 0;
      }
      this.record(transaction);
      return 1;
    } catch (error) {
      this.monitor.failed(candidate, error);
      return 0;
    }
  }

  private record(transaction: WagerTransaction): void {
    if (transaction.status === WagerTransactionStatus.PendingReference) {
      this.monitor.retryScheduled(transaction);
      return;
    }
    this.monitor.resolved(transaction, outcomeOf(transaction));
    this.wagerMonitor.recorded(transaction);
  }
}

function outcomeOf(transaction: WagerTransaction): PendingReferenceOutcome {
  if (transaction.status === WagerTransactionStatus.Processed) {
    return 'processed';
  }
  if (transaction.status === WagerTransactionStatus.Failed) {
    return 'failed';
  }
  return transaction.failureCode === FailureCode.REFERENCE_NOT_FOUND
    ? 'expired'
    : 'rejected';
}

function isInternal(error: unknown): boolean {
  return (
    !(error instanceof DomainError) ||
    error.failureKind === FailureKind.INTERNAL
  );
}
