import { describe, it, expect } from 'bun:test';

import {
  ledgerCursor,
  encodeLedgerCursor,
} from '../../../src/infra/http/wallet/ledger.cursor';

describe('cursor do ledger', () => {
  it('preserva a versão', () =>
    expect(ledgerCursor.parse(encodeLedgerCursor(42))).toBe(42));

  it.each([
    '%',
    'a',
    '',
    Buffer.from('{').toString('base64url'),
    ...[
      { v: 2, walletVersion: 1 },
      { v: 1, walletVersion: 0 },
      { v: 1, walletVersion: -1 },
      { v: 1, walletVersion: 1.5 },
      { v: 1, walletVersion: '2' },
      { v: 1, walletVersion: 2147483648 },
      { v: 1, walletVersion: 1, extra: true },
    ].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url')),
  ])('recusa cursor inválido %s', (cursor) =>
    expect(ledgerCursor.safeParse(cursor).success).toBe(false),
  );
});
