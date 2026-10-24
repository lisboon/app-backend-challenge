import { defineEntity, p } from '@mikro-orm/postgresql';

export const WagerTransactionModel = defineEntity({
  name: 'WagerTransactionModel',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string(),
    walletId: p.uuid(),
    playerId: p.uuid(),
    currency: p.string().length(3),
    roundId: p.string().nullable(),
    gameId: p.string().nullable(),
    kind: p.string(),
    amount: p.decimal('string').precision(20).scale(2),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
