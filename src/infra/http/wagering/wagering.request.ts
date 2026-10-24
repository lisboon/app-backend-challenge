import { z } from 'zod';

import { uuid } from '../shared/validation/uuid';

const providerId = z.string().min(1).max(64);
const identifier = z.string().min(1).max(128);

export const idempotencyKey = z.string().max(255);

export const transactionIdParam = uuid;

export const providerTransactionParams = z.strictObject({
  providerId,
  externalTransactionId: identifier,
});

export const submitWagerTransactionRequest = z.strictObject({
  providerId,
  externalTransactionId: identifier,
  playerId: uuid,
  walletId: uuid,
  roundId: identifier,
  gameId: identifier,
  kind: z.enum(['OPENING', 'BET', 'WIN', 'LOSS']),
  money: z.strictObject({
    amount: z.string(),
    currency: z.string(),
  }),
});
