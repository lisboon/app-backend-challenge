import { beforeAll, afterAll, describe, it, expect } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';

import { startApp } from '../support/http-app';
import {
  openTestOrm,
  migrateFresh,
  ledgerMatchesBalance,
} from '../support/database';
import { debitWallet } from '../support/ledger';
import type { ListWalletLedgerUseCaseOutputDto } from '../../src/modules/wallet/usecase/list-wallet-ledger/list-wallet-ledger.usecase.dto';

type Page = {
  items: ListWalletLedgerUseCaseOutputDto['items'];
  nextCursor: string | null;
};

describe('extrato com infraestrutura real', () => {
  let orm: MikroORM;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    ({ app, baseUrl } = await startApp());
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  const open = async (amount = '100.00', currency = 'BRL') => {
    const response = await fetch(baseUrl + '/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount, currency },
      }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };

  const page = async (id: string, query = ''): Promise<Page> => {
    const response = await fetch(
      baseUrl + '/wallets/' + id + '/ledger' + query,
    );
    expect(response.status).toBe(200);
    return response.json() as Promise<Page>;
  };

  const invariant = async (id: string) => {
    const balance = await ledgerMatchesBalance(orm, id);
    expect(balance.stored).toBe(balance.rebuilt);
  };

  it('percorre sete lançamentos sem repetição nem deslocamento por novo débito', async () => {
    const id = await open();
    for (let i = 0; i < 6; i++) {
      await debitWallet(orm, id);
    }
    const first = await page(id, '?limit=3');
    expect(first.items.map((e) => e.walletVersion)).toEqual([7, 6, 5]);
    expect(first.items[0]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'DEBIT',
      money: { amount: '1.00', currency: 'BRL' },
      balanceBefore: { amount: '95.00', currency: 'BRL' },
      balanceAfter: { amount: '94.00', currency: 'BRL' },
      walletVersion: 7,
      createdAt: expect.stringMatching(/Z$/),
    });
    await debitWallet(orm, id);
    const second = await page(id, '?limit=3&cursor=' + first.nextCursor);
    expect(second.items.map((e) => e.walletVersion)).toEqual([4, 3, 2]);
    const last = await page(id, '?limit=3&cursor=' + second.nextCursor);
    expect(last.items.map((e) => e.walletVersion)).toEqual([1]);
    expect(last.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items, ...last.items].map((e) => e.id))
        .size,
    ).toBe(7);
    await invariant(id);
  });

  it('wallet zero tem extrato vazio', async () => {
    const id = await open('0.00');
    expect(await page(id)).toEqual({ items: [], nextCursor: null });
    await invariant(id);
  });

  it.each([
    'cursor=adulterado',
    'limit=0',
    'limit=101',
    'limit=abc',
    'limit=1.5',
    'unknown=true',
    'limit=3&limit=4',
  ])('recusa query %s', async (query) => {
    const response = await fetch(
      baseUrl + '/wallets/' + Bun.randomUUIDv7() + '/ledger?' + query,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      failureCode: 'REQUEST_INVALID',
    });
  });

  it.each([
    ['abc', 400, 'REQUEST_INVALID'],
    [Bun.randomUUIDv7(), 404, 'WALLET_NOT_FOUND'],
  ])('valida id %s', async (id, status, failureCode) => {
    const response = await fetch(baseUrl + '/wallets/' + id + '/ledger');
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ failureCode });
  });

  it('preserva valores além da precisão de number e a moeda da wallet', async () => {
    const id = await open('999999999999999999.99', 'USD');
    const entries = await page(id, '?limit=100');
    expect(entries.items[0].money).toEqual({
      amount: '999999999999999999.99',
      currency: 'USD',
    });
    expect(entries.items[0].balanceBefore.currency).toBe('USD');
    expect(entries.items[0].balanceAfter.currency).toBe('USD');
    expect(entries.nextCursor).toBeNull();
    await invariant(id);
  });

  it('usa limite padrão de cinquenta e aceita o teto de cem', async () => {
    const id = await open();
    for (let i = 0; i < 50; i++) {
      await debitWallet(orm, id);
    }
    const first = await page(id);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    expect((await page(id, '?limit=100')).items).toHaveLength(51);
    await invariant(id);
  });
});
