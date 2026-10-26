import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';

import type { RequestAuthenticator } from '../../src/infra/http/shared/auth/request-authenticator';
import { startApp } from '../support/http-app';

const UNREACHABLE_DATABASE = 'postgresql://wager:wager@127.0.0.1:1/wager';

const openWallet = (baseUrl: string): Promise<Response> =>
  fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    }),
  });

describe('ponto de extensão de autenticação', () => {
  describe('com o autenticador de produção', () => {
    let app: INestApplication;
    let baseUrl: string;

    beforeAll(async () => {
      ({ app, baseUrl } = await startApp({
        databaseUrl: UNREACHABLE_DATABASE,
      }));
    });

    afterAll(async () => {
      await app.close();
    });

    it('deixa a rota de negócio chegar ao caso de uso', async () => {
      const response = await openWallet(baseUrl);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        failureCode: 'INFRASTRUCTURE_UNAVAILABLE',
      });
    });
  });

  describe('com um autenticador que recusa toda requisição', () => {
    let app: INestApplication;
    let baseUrl: string;
    const seen: string[] = [];
    const denying: RequestAuthenticator = {
      authenticate: (request) => {
        seen.push(`${request.method} ${request.path}`);
        return Promise.resolve(false);
      },
    };

    beforeAll(async () => {
      ({ app, baseUrl } = await startApp(
        { databaseUrl: UNREACHABLE_DATABASE },
        { authenticator: denying },
      ));
    });

    afterAll(async () => {
      await app.close();
    });

    it.each([
      ['POST /wallets', () => openWallet(baseUrl)],
      [
        'GET /wallets/:walletId',
        () => fetch(`${baseUrl}/wallets/${Bun.randomUUIDv7()}`),
      ],
      [
        'GET /wagering/transactions/:transactionId',
        () => fetch(`${baseUrl}/wagering/transactions/${Bun.randomUUIDv7()}`),
      ],
      ['GET /metrics', () => fetch(`${baseUrl}/metrics`)],
    ])('o guard global bloqueia %s antes do banco', async (_route, request) => {
      const before = seen.length;

      const response = await request();

      expect(response.status).toBe(403);
      expect(response.headers.get('x-correlation-id')).toBeTruthy();
      expect(seen).toHaveLength(before + 1);
    });

    it.each([
      ['/health/live', 200],
      ['/health/ready', 503],
    ])('%s fica aberto sem consultar o autenticador', async (path, status) => {
      const before = seen.length;

      expect((await fetch(baseUrl + path)).status).toBe(status);
      expect(seen).toHaveLength(before);
    });
  });
});
