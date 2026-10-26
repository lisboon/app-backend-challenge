import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction.entity';
import type { WagerTransactionMonitor } from '../../src/modules/wagering/gateway/wager-transaction-monitor.gateway';

export class RecordingWagerMonitor implements WagerTransactionMonitor {
  readonly recordings: { status: string; transactionId: string }[] = [];

  readonly replays: { status: string; transactionId: string }[] = [];

  recorded(transaction: WagerTransaction): void {
    this.recordings.push({
      status: transaction.status,
      transactionId: transaction.id,
    });
  }

  replayed(transaction: WagerTransaction): void {
    this.replays.push({
      status: transaction.status,
      transactionId: transaction.id,
    });
  }
}
