import { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import { WagerTransaction } from '../domain/wager-transaction.entity';

export interface WagerTransactionGateway {
  create(transaction: WagerTransaction, trx: TransactionContext): Promise<void>;
}
