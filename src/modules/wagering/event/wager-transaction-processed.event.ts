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

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';

  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    if (transaction.status !== WagerTransactionStatus.Processed) {
      throw new Error('evento exige transação processada');
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.walletId,
      data: transactionEventData(transaction),
    });
  }
}
