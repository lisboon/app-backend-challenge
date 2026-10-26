import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';

import { migrateFresh, openTestOrm } from '../support/database';
import { startApp } from '../support/http-app';
import { freePort, spawnApp, testAppEnv, waitReady } from '../support/process';

const uuid = (): string => Bun.randomUUIDv7();
const SECRET_AMOUNT = '123456.78';

describe('observabilidade das requisições HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const orm = await openTestOrm();
    await migrateFresh(orm);
    await orm.close(true);
    ({ app, baseUrl } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('mede a latência pelo padrão da rota, nunca pelo caminho com ids', async () => {
    const missingWallet = uuid();
    const created = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: uuid(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(created.status).toBe(201);
    expect((await fetch(`${baseUrl}/wallets/${missingWallet}`)).status).toBe(
      404,
    );
    expect(
      (
        await fetch(`${baseUrl}/wallets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400);
    expect((await fetch(`${baseUrl}/rota-inexistente/${uuid()}`)).status).toBe(
      404,
    );

    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    for (const series of [
      'http_request_duration_seconds_count{method="POST",route="/wallets",status="201"} 1',
      'http_request_duration_seconds_count{method="GET",route="/wallets/:walletId",status="404"} 1',
      'http_request_duration_seconds_count{method="POST",route="unmatched",status="400"} 1',
      'http_request_duration_seconds_count{method="GET",route="unmatched",status="404"} 1',
    ]) {
      expect(metrics).toContain(series);
    }
    expect(metrics).not.toContain(missingWallet);
  });

  it('a API real escreve log JSON por requisição com a correlação da resposta e sem valores', async () => {
    const port = freePort();
    const child = spawnApp(testAppEnv(port));
    const stdout = new Response(child.stdout).text();
    try {
      await waitReady(port);
      const response = await fetch(`http://127.0.0.1:${port}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          playerId: uuid(),
          initialBalance: { amount: SECRET_AMOUNT, currency: 'BRL' },
        }),
      });
      expect(response.status).toBe(201);
      const correlationId = response.headers.get('x-correlation-id');
      expect(correlationId).toBeTruthy();
      await Bun.sleep(200);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }

    const output = await stdout;
    expect(output).not.toContain(SECRET_AMOUNT);
    const lines = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { message: unknown });
    const requests = lines
      .map((line) => line.message)
      .filter(
        (message): message is Record<string, unknown> =>
          typeof message === 'object' &&
          message !== null &&
          (message as { event?: unknown }).event === 'http_request',
      );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      route: '/wallets',
      status: 201,
    });
    expect(typeof requests[0].durationMs).toBe('number');
    expect(requests[0].correlationId).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);
});
