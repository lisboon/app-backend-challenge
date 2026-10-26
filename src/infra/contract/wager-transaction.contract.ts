import { z } from 'zod';

import { uuid } from './uuid.contract';

const storableText = z
  .string()
  .regex(/^[^\0]*$/, 'texto não pode conter o caractere NUL');

export const providerId = storableText.min(1).max(64);

export const identifier = storableText.min(1).max(128);

export const idempotencyKey = storableText.max(255);

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

export const wagerTransactionMessageContract = z.strictObject({
  messageId: identifier,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime({ offset: true }),
  data: submitWagerTransactionContract.extend({
    idempotencyKey: idempotencyKey.trim().min(1),
  }),
});

export type WagerTransactionMessage = z.infer<
  typeof wagerTransactionMessageContract
>;
