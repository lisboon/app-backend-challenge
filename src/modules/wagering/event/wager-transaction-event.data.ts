import type { MoneyProps } from '../../@shared/domain/money';
import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
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
  balance: MoneyProps | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
}

export function transactionEventData(
  transaction: WagerTransaction,
): WagerTransactionEventData {
  if (
    !transaction.resultBalance &&
    transaction.status !== WagerTransactionStatus.PendingReference
  ) {
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
    balance: transaction.resultBalance?.toJSON() ?? null,
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
  };
}
