import { z } from 'zod';

const cursorState = z.strictObject({
  v: z.literal(1),
  walletVersion: z.number().int().min(1).max(2147483647),
});

function invalidCursor(ctx: z.RefinementCtx): typeof z.NEVER {
  ctx.addIssue({ code: 'custom', message: 'cursor inválido' });
  return z.NEVER;
}

function decodeLedgerCursor(
  cursor: string,
  ctx: z.RefinementCtx,
): number | typeof z.NEVER {
  let state: unknown;
  try {
    state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return invalidCursor(ctx);
  }

  const result = cursorState.safeParse(state);
  if (!result.success) {
    return invalidCursor(ctx);
  }
  return result.data.walletVersion;
}

export const ledgerCursor = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'cursor inválido')
  .transform(decodeLedgerCursor);

export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: 1, walletVersion })).toString(
    'base64url',
  );
}
