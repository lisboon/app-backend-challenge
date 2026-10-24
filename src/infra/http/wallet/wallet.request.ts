import { z } from 'zod';

import { uuid } from '../shared/validation/uuid';
import { ledgerCursor } from './ledger.cursor';

export const ledgerQuery = z.strictObject({
  cursor: ledgerCursor.optional(),
  limit: z
    .string()
    .regex(/^[0-9]+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .default(50),
});

export const walletIdParam = uuid;

export const createWalletRequest = z.strictObject({
  playerId: uuid,
  initialBalance: z.strictObject({
    amount: z.string(),
    currency: z.string(),
  }),
});
