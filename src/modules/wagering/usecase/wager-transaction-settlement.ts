import type { EventContext } from '../../@shared/domain/event/integration-event';
import { FailureCode } from '../../@shared/domain/failure-code';
import { OutboxMessage } from '../../@shared/domain/outbox/outbox-message.entity';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../@shared/gateway/id-generator.gateway';
import type { OutboxGateway } from '../../@shared/gateway/outbox.gateway';
import {
  WagerTransactionStatus,
  type WagerTransaction,
} from '../domain/wager-transaction.entity';
import { WagerTransactionPendingReference } from '../event/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '../event/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../event/wager-transaction-rejected.event';
import type { WagerTransactionGateway } from '../gateway/wager-transaction.gateway';
import type { LockedWallet } from '../gateway/wallet-movement.gateway';

export class WagerTransactionSettlement {
  constructor(
    private readonly wagers: WagerTransactionGateway,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly outbox: OutboxGateway,
    private readonly ttlSeconds: number,
  ) {}

  async apply(
    transaction: WagerTransaction,
    wallet: LockedWallet,
    trx: TransactionContext,
  ): Promise<void> {
    const at = this.clock.now();
    const reference = await this.referenceOf(transaction, trx);
    const reversals = reference
      ? await this.wagers.findReversals(reference.id, trx)
      : [];
    const rejection = transaction.rejectionFor(wallet, reference, reversals);
    if (rejection) {
      await this.reject(transaction, wallet, rejection, at, trx);
      return;
    }
    if (transaction.awaitsReference(reference)) {
      await this.awaitReference(transaction, wallet, reference, at, trx);
      return;
    }
    await this.process(transaction, wallet, reference, at, trx);
  }

  private async referenceOf(
    transaction: WagerTransaction,
    trx: TransactionContext,
  ): Promise<WagerTransaction | null> {
    if (transaction.referenceExternalTransactionId === undefined) {
      return null;
    }
    const reference = await this.wagers.findByExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
      trx,
    );
    return reference?.status === WagerTransactionStatus.Failed
      ? null
      : reference;
  }

  private async awaitReference(
    transaction: WagerTransaction,
    wallet: LockedWallet,
    reference: WagerTransaction | null,
    at: Date,
    trx: TransactionContext,
  ): Promise<void> {
    if (transaction.status === WagerTransactionStatus.Pending) {
      transaction.markPendingReference(at, this.ttlSeconds);
      await this.enqueue(
        WagerTransactionPendingReference.from(
          transaction,
          this.context(transaction, at),
        ),
        trx,
      );
      return;
    }
    if (!reference && transaction.referenceExpired(at, this.ttlSeconds)) {
      await this.reject(
        transaction,
        wallet,
        FailureCode.REFERENCE_NOT_FOUND,
        at,
        trx,
      );
      return;
    }
    transaction.scheduleReferenceRetry(
      at,
      reference ? undefined : this.ttlSeconds,
    );
  }

  private async process(
    transaction: WagerTransaction,
    wallet: LockedWallet,
    reference: WagerTransaction | null,
    at: Date,
    trx: TransactionContext,
  ): Promise<void> {
    const context = this.context(transaction, at);
    const movement = transaction.affectsBalance()
      ? await wallet.apply({
          eventContext: {
            eventId: this.ids.next(),
            correlationId: transaction.correlationId,
            causationId: context.eventId,
            occurredAt: at,
          },
          transactionId: transaction.id,
          entryId: this.ids.next(),
          direction: transaction.ledgerDirectionFor(reference ?? undefined),
          money: transaction.money,
          at,
        })
      : null;
    transaction.markProcessed(
      movement?.balance ?? wallet.balance,
      at,
      reference?.id,
    );
    await this.enqueue(
      WagerTransactionProcessed.from(transaction, context),
      trx,
    );
    await movement?.recordBalanceChanged();
    await this.wagers.accelerateReferences(transaction, at, trx);
  }

  private async reject(
    transaction: WagerTransaction,
    wallet: LockedWallet,
    code: FailureCode,
    at: Date,
    trx: TransactionContext,
  ): Promise<void> {
    transaction.reject(code, wallet.balance, at);
    await this.enqueue(
      WagerTransactionRejected.from(transaction, this.context(transaction, at)),
      trx,
    );
  }

  private enqueue(
    event:
      | WagerTransactionPendingReference
      | WagerTransactionProcessed
      | WagerTransactionRejected,
    trx: TransactionContext,
  ): Promise<void> {
    return this.outbox.create(OutboxMessage.enqueue(event), trx);
  }

  private context(transaction: WagerTransaction, at: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: transaction.correlationId,
      occurredAt: at,
    };
  }
}
