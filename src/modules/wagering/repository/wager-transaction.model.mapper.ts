import type { InferEntity } from '@mikro-orm/postgresql';

import type { FailureCode } from '../../@shared/domain/failure-code';
import { Money } from '../../@shared/domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../domain/wager-transaction.entity';
import type { WagerTransactionModel } from './wager-transaction.model';

export type WagerTransactionRow = InferEntity<typeof WagerTransactionModel>;

export const WagerTransactionModelMapper = {
  toModel(transaction: WagerTransaction): WagerTransactionRow {
    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      currency: transaction.money.currency,
      roundId: transaction.roundId ?? null,
      gameId: transaction.gameId ?? null,
      kind: transaction.kind,
      amount: transaction.money.toString(),
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      resultBalance: transaction.resultBalance?.toString() ?? null,
      resultCurrency: transaction.resultBalance?.currency ?? null,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt ?? null,
    };
  },

  toEntity(row: WagerTransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId ?? undefined,
      gameId: row.gameId ?? undefined,
      kind: row.kind as WagerTransactionKind,
      money: Money.from({ amount: row.amount, currency: row.currency }),
      createdAt: row.createdAt,
      status: row.status as WagerTransactionStatus,
      failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
      resultBalance:
        row.resultBalance && row.resultCurrency
          ? Money.from({
              amount: row.resultBalance,
              currency: row.resultCurrency,
            })
          : undefined,
      processedAt: row.processedAt ?? undefined,
    });
  },
};
