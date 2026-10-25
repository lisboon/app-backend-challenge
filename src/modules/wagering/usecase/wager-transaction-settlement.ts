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
    private readonly ttlSeconds = 3600,
  ) {}

  async apply(
    transaction: WagerTransaction,
    wallet: LockedWallet,
    trx: TransactionContext,
  ): Promise<void> {
    const at = this.clock.now();
    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? null
        : await this.wagers.findByExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
            trx,
          );
    const reversals = reference
      ? await this.wagers.findReversals(reference.id, trx)
      : [];
    const rejection = transaction.rejectionFor(wallet, reference, reversals);
    if (rejection) {
      await this.reject(transaction, wallet, rejection, at, trx);
      return;
    }
    if (
      transaction.requiresReference() &&
      reference?.status !== WagerTransactionStatus.Processed
    ) {
      if (
        !reference &&
        transaction.status === WagerTransactionStatus.PendingReference &&
        transaction.referenceExpired(at, this.ttlSeconds)
      ) {
        await this.reject(
          transaction,
          wallet,
          FailureCode.REFERENCE_NOT_FOUND,
          at,
          trx,
        );
      } else if (transaction.status === WagerTransactionStatus.Pending) {
        transaction.markPendingReference(at, this.ttlSeconds);
        await this.outbox.create(
          OutboxMessage.enqueue(
            WagerTransactionPendingReference.from(
              transaction,
              this.context(transaction, at),
            ),
          ),
          trx,
        );
      } else {
        transaction.scheduleReferenceRetry(
          at,
          reference ? undefined : this.ttlSeconds,
        );
      }
      return;
    }
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
    await this.outbox.create(
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(transaction, context),
      ),
      trx,
    );
    await movement?.recordBalanceChanged();
    await this.wagers.accelerateReferences(transaction, at, trx);
  }

  private context(transaction: WagerTransaction, at: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: transaction.correlationId,
      occurredAt: at,
    };
  }

  private async reject(
    transaction: WagerTransaction,
    wallet: LockedWallet,
    code: FailureCode,
    at: Date,
    trx: TransactionContext,
  ): Promise<void> {
    transaction.reject(code, wallet.balance, at);
    await this.outbox.create(
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(
          transaction,
          this.context(transaction, at),
        ),
      ),
      trx,
    );
  }
}
