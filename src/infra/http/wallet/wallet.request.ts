import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());

export const walletIdParam = uuid;

export const createWalletRequest = z.strictObject({
  playerId: uuid,
  initialBalance: z.strictObject({
    amount: z.string(),
    currency: z.string(),
  }),
});
