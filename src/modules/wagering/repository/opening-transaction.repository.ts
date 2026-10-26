import { OutboxMessage } from '../../@shared/domain/outbox/outbox-message.entity';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type { OutboxGateway } from '../../@shared/gateway/outbox.gateway';
import type {
  OpeningTransactionGateway,
  WalletOpening,
} from '../../wallet/gateway/opening-transaction.gateway';
import { WagerTransaction } from '../domain/wager-transaction.entity';
import { WagerTransactionProcessed } from '../event/wager-transaction-processed.event';
import type { WagerTransactionGateway } from '../gateway/wager-transaction.gateway';

export class OpeningTransactionRepository implements OpeningTransactionGateway {
  constructor(
    private readonly transactions: WagerTransactionGateway,
    private readonly outbox: OutboxGateway,
  ) {}

  async create(opening: WalletOpening, trx: TransactionContext): Promise<void> {
    const transaction = WagerTransaction.opening({
      ...opening,
      correlationId: opening.eventContext.correlationId,
    });
    await this.transactions.create(transaction, trx);
    await this.outbox.create(
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(transaction, opening.eventContext),
      ),
      trx,
    );
  }
}
