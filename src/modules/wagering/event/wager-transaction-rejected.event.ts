import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from '../../@shared/domain/event/integration-event';
import type { FailureCode } from '../../@shared/domain/failure-code';
import {
  WagerTransactionStatus,
  type WagerTransaction,
} from '../domain/wager-transaction.entity';
import {
  transactionEventData,
  type WagerTransactionEventData,
} from './wager-transaction-event.data';

interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';

  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionRejectedData>,
  ) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      !transaction.failureCode
    ) {
      throw new Error('evento exige transação rejeitada com código de falha');
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...transactionEventData(transaction),
        failureCode: transaction.failureCode,
      },
    });
  }
}
