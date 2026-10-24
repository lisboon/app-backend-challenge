import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type {
  OpeningTransactionGateway,
  WalletOpening,
} from '../../wallet/gateway/opening-transaction.gateway';
import { WagerTransaction } from '../domain/wager-transaction.entity';
import type { WagerTransactionGateway } from '../gateway/wager-transaction.gateway';

export class OpeningTransactionRepository implements OpeningTransactionGateway {
  constructor(private readonly transactions: WagerTransactionGateway) {}

  create(opening: WalletOpening, trx: TransactionContext): Promise<void> {
    return this.transactions.create(WagerTransaction.opening(opening), trx);
  }
}
