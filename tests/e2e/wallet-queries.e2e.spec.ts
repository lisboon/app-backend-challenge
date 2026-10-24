import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import type { INestApplication } from '@nestjs/common';

import { startApp } from '../support/http-app';

describe('validação HTTP do extrato sem infraestrutura', () => {
  let app: INestApplication, baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await startApp({
      databaseUrl: 'postgresql://wager:wager@127.0.0.1:1/wager',
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    'cursor=%25',
    'cursor=',
    'limit=0',
    'limit=101',
    'limit=abc',
    'limit=1.2',
    'other=1',
  ])('recusa %s antes do banco', async (query) => {
    const response = await fetch(
      baseUrl + '/wallets/' + Bun.randomUUIDv7() + '/ledger?' + query,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      failureCode: 'REQUEST_INVALID',
    });
  });

  it.each(['ledger'])(
    'recusa UUID inválido em %s',
    async (route) => {
      const response = await fetch(baseUrl + '/wallets/abc/' + route, {
        method: route === 'ledger' ? 'GET' : 'POST',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        failureCode: 'REQUEST_INVALID',
      });
    },
  );
});
