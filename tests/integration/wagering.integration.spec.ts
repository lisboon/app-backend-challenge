import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';

import { FailureCode } from '../../src/modules/@shared/domain/failure-code';
import {
  ledgerMatchesBalance,
  migrateFresh,
  openTestOrm,
} from '../support/database';
import { startApp } from '../support/http-app';
import {
  type AppProcess,
  freePort,
  spawnApp,
  testAppEnv,
  waitReady,
} from '../support/process';
import { retryTransient } from '../support/retry-transient';

const uuid = (): string => Bun.randomUUIDv7();

const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface Submitted {
  transactionId: string;
  status: string;
  failureCode: string | null;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
}

interface WagerOverrides {
  kind?: string;
  money?: { amount: string; currency: string };
  externalTransactionId?: string;
  playerId?: string;
  providerId?: string;
  roundId?: string;
}

describe('wagering (integração HTTP com PostgreSQL real)', () => {
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
    const playerId = uuid();
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount, currency },
      }),
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    return { walletId: id, playerId };
  };

  const wager = (
    wallet: { walletId: string; playerId: string },
    overrides: WagerOverrides = {},
  ) => ({
    providerId: 'provider-a',
    externalTransactionId: uuid(),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('10.00'),
    ...overrides,
  });

  const submit = (body: unknown, key: string | null = uuid(), url = baseUrl) =>
    fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify(body),
    });

  const submitEventually = (body: unknown, key = uuid(), url = baseUrl) =>
    retryTransient(() => submit(body, key, url));

  const balanceOf = async (walletId: string): Promise<string> => {
    const response = await fetch(`${baseUrl}/wallets/${walletId}`);
    return ((await response.json()) as { balance: { amount: string } }).balance
      .amount;
  };

  const invariant = async (walletId: string) => {
    const balance = await ledgerMatchesBalance(orm, walletId);
    expect(balance.stored).toBe(balance.rebuilt);
  };

  const count = async (sql: string, params: unknown[]): Promise<number> => {
    const [{ n }] = await orm.em
      .fork()
      .getConnection()
      .execute<{ n: string }[]>(sql, params);
    return Number(n);
  };

  describe('POST /wagering/transactions', () => {
    it('provider reservado responde 400 sem gravar transação ou evento', async () => {
      const wallet = await open();
      const response = await submit(wager(wallet, { providerId: 'internal' }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        failureCode: 'PROVIDER_RESERVED',
      });
      expect(
        await count(
          'select count(*) as n from wager_transactions where wallet_id = ?',
          [wallet.walletId],
        ),
      ).toBe(1);
      expect(
        await count(
          'select count(*) as n from outbox_messages where aggregate_id = ?',
          [wallet.walletId],
        ),
      ).toBe(2);
      await invariant(wallet.walletId);
    });

    it('estouro do limite é rejeitado, consultável, idempotente e gera evento', async () => {
      const wallet = await open('999999999999999999.99');
      const body = wager(wallet, { kind: 'WIN', money: brl('0.01') });
      const key = uuid();
      const response = await submit(body, key);
      expect(response.status).toBe(422);
      const rejected = (await response.json()) as Submitted;
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        failureCode: 'BALANCE_LIMIT_EXCEEDED',
        balance: brl('999999999999999999.99'),
      });
      const get = await fetch(
        `${baseUrl}/wagering/transactions/${rejected.transactionId}`,
      );
      expect(get.status).toBe(200);
      expect(await get.json()).toMatchObject({
        status: 'REJECTED',
        failureCode: 'BALANCE_LIMIT_EXCEEDED',
      });
      const replay = await submit(body, key);
      expect(replay.status).toBe(422);
      expect(await replay.json()).toEqual({
        ...rejected,
        idempotentReplay: true,
      });
      expect(
        await count(
          "select count(*) as n from outbox_messages where event_type = 'WagerTransactionRejected' and payload->'data'->>'transactionId' = ?",
          [rejected.transactionId],
        ),
      ).toBe(1);
      expect(await balanceOf(wallet.walletId)).toBe('999999999999999999.99');
      await invariant(wallet.walletId);
    });

    it('saldo 100, apostas de 80 e 80: a primeira aplica e a segunda é rejeitada', async () => {
      const wallet = await open('100.00');

      const first = await submit(wager(wallet, { money: brl('80.00') }));
      const second = await submit(wager(wallet, { money: brl('80.00') }));

      expect(first.status).toBe(201);
      expect(await first.json()).toMatchObject({
        status: 'PROCESSED',
        failureCode: null,
        balance: brl('20.00'),
        idempotentReplay: false,
      });
      expect(second.status).toBe(422);
      expect(await second.json()).toMatchObject({
        status: 'REJECTED',
        failureCode: FailureCode.INSUFFICIENT_BALANCE,
        balance: brl('20.00'),
        idempotentReplay: false,
      });
      expect(await balanceOf(wallet.walletId)).toBe('20.00');
      await invariant(wallet.walletId);
    });

    it('WIN credita e LOSS registra sem mexer no saldo nem no ledger', async () => {
      const wallet = await open('10.00');

      const win = await submit(
        wager(wallet, { kind: 'WIN', money: brl('5.50') }),
      );
      const loss = await submit(
        wager(wallet, { kind: 'LOSS', money: brl('0.00') }),
      );

      expect(win.status).toBe(201);
      expect(((await win.json()) as Submitted).balance).toEqual(brl('15.50'));
      expect(loss.status).toBe(201);
      expect(((await loss.json()) as Submitted).balance).toEqual(brl('15.50'));
      expect(
        await count(
          'select count(*) as n from wallet_ledger_entries where wallet_id = ?',
          [wallet.walletId],
        ),
      ).toBe(2);
      await invariant(wallet.walletId);
    });

    it('aposta igual ao saldo zera a wallet', async () => {
      const wallet = await open('10.00');

      const response = await submit(wager(wallet, { money: brl('10.00') }));

      expect(response.status).toBe(201);
      expect(await balanceOf(wallet.walletId)).toBe('0.00');
    });

    it('preserva centavos que number arredondaria', async () => {
      const wallet = await open('90071992547409.93');

      const response = await submit(
        wager(wallet, { money: brl('90071992547409.91') }),
      );

      expect(((await response.json()) as Submitted).balance).toEqual(
        brl('0.02'),
      );
    });

    it('reenvio com a mesma chave devolve o resultado original sem reaplicar', async () => {
      const wallet = await open('100.00');
      const body = wager(wallet, { money: brl('30.00') });
      const key = uuid();

      const first = (await (await submit(body, key)).json()) as Submitted;
      await submit(wager(wallet, { money: brl('5.00') }));
      const replay = await submit(body, key);

      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual({
        ...first,
        balance: brl('70.00'),
        idempotentReplay: true,
      });
      expect(await balanceOf(wallet.walletId)).toBe('65.00');
      await invariant(wallet.walletId);
    });

    it('reenvio de uma rejeição repete 422 e o mesmo código', async () => {
      const wallet = await open('1.00');
      const body = wager(wallet);
      const key = uuid();

      await submit(body, key);
      const replay = await submit(body, key);

      expect(replay.status).toBe(422);
      expect(await replay.json()).toMatchObject({
        status: 'REJECTED',
        failureCode: FailureCode.INSUFFICIENT_BALANCE,
        idempotentReplay: true,
      });
    });

    it('mesma chave com payload diferente é conflito e não altera nada', async () => {
      const wallet = await open('100.00');
      const body = wager(wallet);
      const key = uuid();
      await submit(body, key);

      const conflict = await submit({ ...body, money: brl('11.00') }, key);

      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        failureCode: FailureCode.IDEMPOTENCY_PAYLOAD_CONFLICT,
      });
      expect(await balanceOf(wallet.walletId)).toBe('90.00');
    });

    it('mesmo externalTransactionId com outra chave é conflito', async () => {
      const wallet = await open('100.00');
      const body = wager(wallet);
      await submit(body);

      const conflict = await submit(body);

      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        failureCode: FailureCode.EXTERNAL_TRANSACTION_CONFLICT,
      });
      expect(await balanceOf(wallet.walletId)).toBe('90.00');
    });

    it('a mesma chave em provedores diferentes são transações distintas', async () => {
      const wallet = await open('100.00');
      const key = uuid();

      const a = await submit(wager(wallet, { providerId: 'provider-a' }), key);
      const b = await submit(wager(wallet, { providerId: 'provider-b' }), key);

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(await balanceOf(wallet.walletId)).toBe('80.00');
    });

    it.each([
      [
        'moeda diferente da wallet',
        { money: { amount: '10.00', currency: 'USD' } },
        FailureCode.CURRENCY_MISMATCH,
      ],
      [
        'player diferente do dono',
        { playerId: uuid() },
        FailureCode.WALLET_PLAYER_MISMATCH,
      ],
    ])(
      'rejeita e registra para auditoria: %s',
      async (_caso, overrides, code) => {
        const wallet = await open('100.00');

        const response = await submit(wager(wallet, overrides));
        const body = (await response.json()) as Submitted;

        expect(response.status).toBe(422);
        expect(body).toMatchObject({ status: 'REJECTED', failureCode: code });
        expect(body.balance).toEqual(brl('100.00'));
        const stored = await fetch(
          `${baseUrl}/wagering/transactions/${body.transactionId}`,
        );
        expect(stored.status).toBe(200);
        expect(await balanceOf(wallet.walletId)).toBe('100.00');
      },
    );

    it('wallet inexistente responde 404 sem gravar transação', async () => {
      const externalTransactionId = uuid();

      const response = await submit(
        wager(
          { walletId: uuid(), playerId: uuid() },
          { externalTransactionId },
        ),
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        failureCode: FailureCode.WALLET_NOT_FOUND,
      });
      expect(
        await count(
          'select count(*) as n from wager_transactions where external_transaction_id = ?',
          [externalTransactionId],
        ),
      ).toBe(0);
    });

    it.each([
      ['sem Idempotency-Key', null, FailureCode.IDEMPOTENCY_KEY_MISSING],
      [
        'com Idempotency-Key em branco',
        '   ',
        FailureCode.IDEMPOTENCY_KEY_MISSING,
      ],
      [
        'com Idempotency-Key longa demais',
        'k'.repeat(256),
        FailureCode.REQUEST_INVALID,
      ],
    ])('responde 400 %s', async (_caso, key, code) => {
      const wallet = await open('100.00');

      const response = await submit(wager(wallet), key);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ failureCode: code });
    });

    it.each([
      [
        'OPENING',
        { kind: 'OPENING' },
        FailureCode.TRANSACTION_KIND_NOT_SUBMITTABLE,
      ],
      ['tipo desconhecido', { kind: 'JACKPOT' }, FailureCode.REQUEST_INVALID],
      [
        'BET de valor zero',
        { money: brl('0.00') },
        FailureCode.TRANSACTION_AMOUNT_INVALID,
      ],
      [
        'valor com três casas',
        { money: brl('1.001') },
        FailureCode.MONEY_INVALID_FORMAT,
      ],
      [
        'valor negativo',
        { money: brl('-1.00') },
        FailureCode.MONEY_INVALID_FORMAT,
      ],
      [
        'moeda inválida',
        { money: { amount: '1.00', currency: 'brl' } },
        FailureCode.CURRENCY_INVALID,
      ],
      ['roundId vazio', { roundId: '' }, FailureCode.REQUEST_INVALID],
    ])('responde 400 para %s', async (_caso, overrides, code) => {
      const wallet = await open('100.00');

      const response = await submit(wager(wallet, overrides));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ failureCode: code });
      expect(await balanceOf(wallet.walletId)).toBe('100.00');
    });

    it('responde 400 para campo desconhecido', async () => {
      const wallet = await open('100.00');

      const response = await submit({ ...wager(wallet), extra: true });

      expect(response.status).toBe(400);
    });
  });

  describe('concorrência', () => {
    it('50 apostas simultâneas de 10 sobre saldo 100: exatamente 10 aplicam', async () => {
      const wallet = await open('100.00');

      const responses = await Promise.all(
        Array.from({ length: 50 }, () => submitEventually(wager(wallet))),
      );
      const statuses = responses.map((response) => response.status);

      expect(statuses.filter((status) => status === 201)).toHaveLength(10);
      expect(statuses.filter((status) => status === 422)).toHaveLength(40);
      expect(await balanceOf(wallet.walletId)).toBe('0.00');
      await invariant(wallet.walletId);
    });

    it('20 reenvios simultâneos da mesma chave aplicam uma única vez', async () => {
      const wallet = await open('100.00');
      const body = wager(wallet);
      const key = uuid();

      const results = (await Promise.all(
        Array.from({ length: 20 }, () =>
          submitEventually(body, key).then((response) => response.json()),
        ),
      )) as Submitted[];

      expect(new Set(results.map((result) => result.transactionId)).size).toBe(
        1,
      );
      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
        1,
      );
      expect(await balanceOf(wallet.walletId)).toBe('90.00');
      await invariant(wallet.walletId);
    });

    it('a mesma chave disputada por duas wallets resolve em uma transação e um conflito', async () => {
      const a = await open('100.00');
      const b = await open('100.00');
      const key = uuid();
      const externalTransactionId = uuid();

      const responses = await Promise.all([
        submitEventually(wager(a, { externalTransactionId }), key),
        submitEventually(wager(b, { externalTransactionId }), key),
      ]);

      expect(
        responses.map((response) => response.status).sort((x, y) => x - y),
      ).toEqual([201, 409]);
      expect(
        [await balanceOf(a.walletId), await balanceOf(b.walletId)].sort(),
      ).toEqual(['100.00', '90.00']);
      await invariant(a.walletId);
      await invariant(b.walletId);
    });

    it('10 wallets em paralelo não se bloqueiam nem se misturam', async () => {
      const wallets = await Promise.all(
        Array.from({ length: 10 }, () => open('50.00')),
      );

      await Promise.all(
        wallets.flatMap((wallet) =>
          Array.from({ length: 5 }, () =>
            submitEventually(wager(wallet, { money: brl('3.00') })),
          ),
        ),
      );

      for (const wallet of wallets) {
        expect(await balanceOf(wallet.walletId)).toBe('35.00');
        await invariant(wallet.walletId);
      }
    });

    it('lock retido além do limite responde 503 com Retry-After e não aplica', async () => {
      const wallet = await open('100.00');
      const em = orm.em.fork();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = em.transactional(async (trx) => {
        await trx.execute('select 1 from wallets where id = ? for update', [
          wallet.walletId,
        ]);
        locked();
        await held;
      });
      await acquired;

      const response = await submit(wager(wallet));
      release();
      await holder;

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).not.toBeNull();
      expect(await response.json()).toMatchObject({
        failureCode: FailureCode.INFRASTRUCTURE_UNAVAILABLE,
      });
      expect(await balanceOf(wallet.walletId)).toBe('100.00');
    }, 10_000);
  });

  describe('vários processos da API', () => {
    const processes: AppProcess[] = [];
    const urls: string[] = [];

    beforeAll(async () => {
      for (let i = 0; i < 3; i += 1) {
        const port = freePort();
        processes.push(spawnApp(testAppEnv(port)));
        urls.push(`http://127.0.0.1:${port}`);
      }
      await Promise.all(
        urls.map((url) => waitReady(Number(new URL(url).port))),
      );
    }, 30_000);

    afterAll(() => {
      for (const child of processes) {
        child.kill('SIGKILL');
      }
    });

    it('3 processos disputando a mesma wallet não gastam além do saldo', async () => {
      const wallet = await open('100.00');

      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          submitEventually(wager(wallet), uuid(), urls[i % urls.length]),
        ),
      );

      expect(
        responses.filter((response) => response.status === 201),
      ).toHaveLength(10);
      expect(
        responses.filter((response) => response.status === 422),
      ).toHaveLength(20);
      expect(await balanceOf(wallet.walletId)).toBe('0.00');
      await invariant(wallet.walletId);
    });

    it('a mesma chave enviada a 3 processos aplica uma única vez', async () => {
      const wallet = await open('100.00');
      const body = wager(wallet);
      const key = uuid();

      const results = (await Promise.all(
        urls.flatMap((url) =>
          Array.from({ length: 5 }, () =>
            submitEventually(body, key, url).then((response) =>
              response.json(),
            ),
          ),
        ),
      )) as Submitted[];

      expect(new Set(results.map((result) => result.transactionId)).size).toBe(
        1,
      );
      expect(await balanceOf(wallet.walletId)).toBe('90.00');
      await invariant(wallet.walletId);
    });
  });

  describe('consultas', () => {
    it('GET por id devolve a transação completa com o saldo observado', async () => {
      const wallet = await open('100.00');
      const body = wager(wallet, { money: brl('25.00') });
      const { transactionId } = (await (
        await submit(body)
      ).json()) as Submitted;

      const response = await fetch(
        `${baseUrl}/wagering/transactions/${transactionId.toUpperCase()}`,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        transactionId,
        providerId: body.providerId,
        externalTransactionId: body.externalTransactionId,
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: brl('25.00'),
        status: 'PROCESSED',
        failureCode: null,
        balance: brl('75.00'),
      });
    });

    it('GET pelo id do provedor encontra a mesma transação', async () => {
      const wallet = await open('100.00');
      const body = wager(wallet);
      const { transactionId } = (await (
        await submit(body)
      ).json()) as Submitted;

      const response = await fetch(
        `${baseUrl}/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ transactionId });
    });

    it('GET de outro provedor não encontra a transação', async () => {
      const wallet = await open('100.00');
      const body = wager(wallet);
      await submit(body);

      const response = await fetch(
        `${baseUrl}/providers/provider-z/wagering/transactions/${body.externalTransactionId}`,
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        failureCode: FailureCode.TRANSACTION_NOT_FOUND,
      });
    });

    it('GET de id inexistente responde 404 e id inválido responde 400', async () => {
      const missing = await fetch(`${baseUrl}/wagering/transactions/${uuid()}`);
      const invalid = await fetch(`${baseUrl}/wagering/transactions/abc`);

      expect(missing.status).toBe(404);
      expect(invalid.status).toBe(400);
    });

    it('a abertura da wallet aparece como transação OPENING processada', async () => {
      const wallet = await open('42.00');

      const response = await fetch(
        `${baseUrl}/providers/internal/wagering/transactions/opening:${wallet.walletId}`,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        kind: 'OPENING',
        status: 'PROCESSED',
        roundId: null,
        balance: brl('42.00'),
      });
    });
  });
});
