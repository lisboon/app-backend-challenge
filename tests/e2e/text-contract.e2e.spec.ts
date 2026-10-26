import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';

import { startApp } from '../support/http-app';

describe('texto que o PostgreSQL não grava, sem infraestrutura', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await startApp({
      databaseUrl: 'postgresql://wager:wager@127.0.0.1:1/wager',
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    'providerId',
    'externalTransactionId',
    'roundId',
    'gameId',
    'referenceExternalTransactionId',
  ])('NUL em %s responde 400 antes do banco', async (field) => {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': Bun.randomUUIDv7(),
      },
      body: JSON.stringify({
        providerId: 'provider-a',
        externalTransactionId: 'transaction-1',
        playerId: Bun.randomUUIDv7(),
        walletId: Bun.randomUUIDv7(),
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: '1.00', currency: 'BRL' },
        [field]: 'a\u0000b',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      failureCode: 'REQUEST_INVALID',
    });
  });
});
