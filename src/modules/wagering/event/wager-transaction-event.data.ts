import type { MoneyProps } from '../../@shared/domain/money';
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.entity';

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  balance: MoneyProps;
}

export function transactionEventData(
  transaction: WagerTransaction,
): WagerTransactionEventData {
  if (!transaction.resultBalance) {
    throw new Error('evento exige saldo observado no desfecho');
  }
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    balance: transaction.resultBalance.toJSON(),
  };
}
