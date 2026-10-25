import { z } from 'zod';

import { uuid } from './uuid.contract';

export const providerId = z.string().min(1).max(64);

export const identifier = z.string().min(1).max(128);

export const idempotencyKey = z.string().max(255);

export const submitWagerTransactionContract = z.strictObject({
  providerId,
  externalTransactionId: identifier,
  playerId: uuid,
  walletId: uuid,
  roundId: identifier,
  gameId: identifier,
  kind: z.enum(['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  referenceExternalTransactionId: identifier.optional(),
  money: z.strictObject({
    amount: z.string(),
    currency: z.string(),
  }),
});
