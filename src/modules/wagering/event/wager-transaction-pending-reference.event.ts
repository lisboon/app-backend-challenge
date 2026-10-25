import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from '../../@shared/domain/event/integration-event';
import {
  WagerTransactionStatus,
  type WagerTransaction,
} from '../domain/wager-transaction.entity';
import {
  transactionEventData,
  type WagerTransactionEventData,
} from './wager-transaction-event.data';

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';

  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      !transaction.referenceExternalTransactionId
    ) {
      throw new Error('evento exige transação aguardando referência');
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.walletId,
      data: transactionEventData(transaction),
    });
  }
}
