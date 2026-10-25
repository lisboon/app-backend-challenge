import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';

import { startApp } from '../support/http-app';

describe('correlação HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([undefined, 'inválido'])(
    'gera UUIDv7 para header %s',
    async (header) => {
      const response = await fetch(baseUrl + '/health/live', {
        headers: header === undefined ? {} : { 'X-Correlation-Id': header },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-correlation-id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    },
  );

  it('preserva e normaliza UUID válido mesmo em resposta de erro', async () => {
    const id = Bun.randomUUIDv7();
    const response = await fetch(baseUrl + '/wallets', {
      method: 'POST',
      headers: {
        'X-Correlation-Id': id.toUpperCase(),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-correlation-id')).toBe(id);
  });

  it.each([
    ['/wallets', 'POST', '{', 400],
    ['/rota-inexistente', 'GET', undefined, 404],
  ] as const)(
    'preserva o header em falha anterior ao handler: %s',
    async (path, method, body, status) => {
      const id = Bun.randomUUIDv7();
      const response = await fetch(baseUrl + path, {
        method,
        headers: {
          'content-type': 'application/json',
          'X-Correlation-Id': id.toUpperCase(),
        },
        ...(method === 'POST' ? { body } : {}),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('x-correlation-id')).toBe(id);
    },
  );
});
