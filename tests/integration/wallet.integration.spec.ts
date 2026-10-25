import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';

import { OutboxRepository } from '../../src/modules/@shared/repository/outbox.repository';
import { MikroOrmTransactionManager } from '../../src/infra/database/mikro-orm-transaction-manager';
import { FailureCode } from '../../src/modules/@shared/domain/failure-code';
import { OpeningTransactionRepository } from '../../src/modules/wagering/repository/opening-transaction.repository';
import { WagerTransactionRepository } from '../../src/modules/wagering/repository/wager-transaction.repository';
import { LedgerRepository } from '../../src/modules/wallet/repository/ledger.repository';
import { WalletRepository } from '../../src/modules/wallet/repository/wallet.repository';
import { CreateWalletUseCase } from '../../src/modules/wallet/usecase/create-wallet/create-wallet.usecase';
import type { WalletOutputDto } from '../../src/modules/wallet/usecase/wallet.output.dto';
import {
  ledgerMatchesBalance,
  migrateFresh,
  openTestOrm,
} from '../support/database';
import { startApp } from '../support/http-app';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const uuid = (): string => Bun.randomUUIDv7();

const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface StoredTransaction {
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  processed: boolean;
}

interface StoredEntry {
  direction: string;
  amount: string;
  before: string;
  after: string;
  wallet_version: number;
}

interface StoredRows {
  wallets: number;
  transactions: StoredTransaction[];
  entries: StoredEntry[];
}

describe('wallets (integração HTTP com PostgreSQL real)', () => {
  let orm: MikroORM;
  let app: INestApplication;
  let baseUrl: string;

  const post = (body: unknown) =>
    fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const stored = async (playerId: string): Promise<StoredRows> => {
    const connection = orm.em.fork().getConnection();
    const [{ n }] = await connection.execute<{ n: string }[]>(
      'select count(*) as n from wallets where player_id = ?',
      [playerId],
    );
    const transactions = await connection.execute<StoredTransaction[]>(
      `select provider_id, external_transaction_id, idempotency_key, kind, status,
              amount::text as amount, currency, processed_at is not null as processed
         from wager_transactions where player_id = ?`,
      [playerId],
    );
    const entries = await connection.execute<StoredEntry[]>(
      `select l.direction, l.amount::text as amount, l.balance_before::text as before,
              l.balance_after::text as after, l.wallet_version
         from wallet_ledger_entries l join wallets w on w.id = l.wallet_id
        where w.player_id = ?`,
      [playerId],
    );
    return { wallets: Number(n), transactions, entries };
  };

  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    ({ app, baseUrl } = await startApp());
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  describe('POST /wallets', () => {
    it('abre a wallet, registra o OPENING e o crédito no ledger na mesma transação', async () => {
      const playerId = uuid();
      const response = await post({ playerId, initialBalance: brl('1000.00') });
      const body = (await response.json()) as WalletOutputDto;

      expect(response.status).toBe(201);
      expect(body).toEqual({
        id: expect.stringMatching(UUID_V7),
        playerId,
        balance: brl('1000.00'),
        version: 1,
      });
      expect(await stored(playerId)).toEqual({
        wallets: 1,
        transactions: [
          {
            provider_id: 'internal',
            external_transaction_id: `opening:${body.id}`,
            idempotency_key: `internal:opening:${body.id}`,
            kind: 'OPENING',
            status: 'PROCESSED',
            amount: '1000.00',
            currency: 'BRL',
            processed: true,
          },
        ],
        entries: [
          {
            direction: 'CREDIT',
            amount: '1000.00',
            before: '0.00',
            after: '1000.00',
            wallet_version: 1,
          },
        ],
      });
      expect(await ledgerMatchesBalance(orm, body.id)).toEqual({
        stored: '1000.00',
        rebuilt: '1000.00',
      });
    });

    it('com saldo zero não cria OPENING nem lançamento', async () => {
      const playerId = uuid();
      const response = await post({ playerId, initialBalance: brl('0.00') });
      const body = (await response.json()) as WalletOutputDto;

      expect(response.status).toBe(201);
      expect(await stored(playerId)).toEqual({
        wallets: 1,
        transactions: [],
        entries: [],
      });
      expect(await ledgerMatchesBalance(orm, body.id)).toEqual({
        stored: '0.00',
        rebuilt: '0.00',
      });
    });

    it('normaliza UUID em maiúsculas para minúsculas', async () => {
      const playerId = uuid();
      const response = await post({
        playerId: playerId.toUpperCase(),
        initialBalance: brl('1.00'),
      });

      expect(((await response.json()) as WalletOutputDto).playerId).toBe(
        playerId,
      );
    });

    it('segunda wallet do mesmo player e moeda é conflito, outra moeda não', async () => {
      const playerId = uuid();
      await post({ playerId, initialBalance: brl('10.00') });
      const duplicate = await post({ playerId, initialBalance: brl('99.00') });
      const otherCurrency = await post({
        playerId,
        initialBalance: { amount: '5.00', currency: 'USD' },
      });

      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({
        failureCode: FailureCode.WALLET_ALREADY_EXISTS,
      });
      expect(otherCurrency.status).toBe(201);
      expect((await stored(playerId)).wallets).toBe(2);
    });

    it('20 aberturas simultâneas do mesmo player e moeda criam uma única wallet', async () => {
      const playerId = uuid();
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          post({ playerId, initialBalance: brl('100.00') }),
        ),
      );
      const statuses = responses
        .map((response) => response.status)
        .sort((a, b) => a - b);
      const created = await Promise.all(
        responses
          .filter((response) => response.status === 201)
          .map((response) => response.json() as Promise<WalletOutputDto>),
      );
      const rows = await stored(playerId);

      expect(statuses).toEqual([201, ...Array(19).fill(409)]);
      expect(rows.wallets).toBe(1);
      expect(rows.transactions).toHaveLength(1);
      expect(rows.entries).toHaveLength(1);
      expect(await ledgerMatchesBalance(orm, created[0].id)).toEqual({
        stored: '100.00',
        rebuilt: '100.00',
      });
    });

    it.each([
      [
        'valor sem casas decimais',
        { amount: '25', currency: 'BRL' },
        FailureCode.MONEY_INVALID_FORMAT,
      ],
      [
        'valor negativo',
        { amount: '-1.00', currency: 'BRL' },
        FailureCode.MONEY_INVALID_FORMAT,
      ],
      [
        'valor numérico',
        { amount: 25, currency: 'BRL' },
        FailureCode.REQUEST_INVALID,
      ],
      [
        'moeda fora do ISO-4217',
        { amount: '1.00', currency: 'brl' },
        FailureCode.CURRENCY_INVALID,
      ],
      [
        'campo extra no dinheiro',
        { amount: '1.00', currency: 'BRL', fee: '1.00' },
        FailureCode.REQUEST_INVALID,
      ],
    ])(
      'recusa %s com 400 e não persiste nada',
      async (_caso, initialBalance, code) => {
        const playerId = uuid();
        const response = await post({ playerId, initialBalance });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ failureCode: code });
        expect((await stored(playerId)).wallets).toBe(0);
      },
    );

    it.each([
      [
        'playerId inválido',
        { playerId: 'nao-e-uuid', initialBalance: brl('1.00') },
      ],
      ['initialBalance ausente', { playerId: uuid() }],
      [
        'campo desconhecido',
        { playerId: uuid(), initialBalance: brl('1.00'), bonus: true },
      ],
      ['corpo que não é objeto', [1, 2]],
      ['JSON malformado', '{"playerId":'],
    ])('recusa %s com 400 REQUEST_INVALID', async (_caso, body) => {
      const response = await post(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        failureCode: FailureCode.REQUEST_INVALID,
      });
    });

    it('a mensagem de erro não repete o valor recebido', async () => {
      const response = await post({
        playerId: uuid(),
        initialBalance: { amount: '123456.789', currency: 'BRL' },
      });

      expect(await response.text()).not.toContain('123456.789');
    });
  });

  describe('dinheiro nunca passa por number', () => {
    const BEYOND_FLOAT = '999999999999999999.99';

    it('preserva na API e no banco um valor que number arredondaria', async () => {
      expect(String(Number(BEYOND_FLOAT))).not.toBe(BEYOND_FLOAT);

      const created = (await (
        await post({ playerId: uuid(), initialBalance: brl(BEYOND_FLOAT) })
      ).json()) as WalletOutputDto;
      const fetched = (await (
        await fetch(`${baseUrl}/wallets/${created.id}`)
      ).json()) as WalletOutputDto;

      expect(created.balance).toEqual(brl(BEYOND_FLOAT));
      expect(fetched.balance).toEqual(brl(BEYOND_FLOAT));
      expect(await ledgerMatchesBalance(orm, created.id)).toEqual({
        stored: BEYOND_FLOAT,
        rebuilt: BEYOND_FLOAT,
      });
    });

    it('o driver entrega NUMERIC como string', async () => {
      const created = (await (
        await post({ playerId: uuid(), initialBalance: brl('0.10') })
      ).json()) as WalletOutputDto;
      const [row] = await orm.em
        .fork()
        .getConnection()
        .execute<{ balance: unknown }[]>(
          'select balance from wallets where id = ?',
          [created.id],
        );

      expect(typeof row.balance).toBe('string');
      expect(row.balance).toBe('0.10');
    });
  });

  describe('GET /wallets/:walletId', () => {
    it('devolve a wallet no mesmo formato da abertura', async () => {
      const created = await (
        await post({ playerId: uuid(), initialBalance: brl('42.00') })
      ).json();
      const response = await fetch(`${baseUrl}/wallets/${created.id}`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(created);
    });

    it('aceita o id em maiúsculas', async () => {
      const created = await (
        await post({ playerId: uuid(), initialBalance: brl('1.00') })
      ).json();
      const response = await fetch(
        `${baseUrl}/wallets/${created.id.toUpperCase()}`,
      );

      expect(response.status).toBe(200);
    });

    it('wallet inexistente responde 404 WALLET_NOT_FOUND', async () => {
      const response = await fetch(`${baseUrl}/wallets/${uuid()}`);

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        failureCode: FailureCode.WALLET_NOT_FOUND,
      });
    });

    it('id que não é UUID responde 400', async () => {
      const response = await fetch(`${baseUrl}/wallets/abc`);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        failureCode: FailureCode.REQUEST_INVALID,
      });
    });
  });

  describe('atomicidade', () => {
    it('falha no ledger desfaz a wallet e o OPENING', async () => {
      const playerId = uuid();
      const failingLedger = new LedgerRepository();
      failingLedger.create = () =>
        Promise.reject(new Error('falha injetada no ledger'));
      const useCase = new CreateWalletUseCase(
        new MikroOrmTransactionManager(orm),
        new WalletRepository(),
        failingLedger,
        new OpeningTransactionRepository(
          new WagerTransactionRepository(),
          new OutboxRepository(),
        ),
        { next: uuid },
        { now: () => new Date() },
        new OutboxRepository(),
      );

      const failure = await useCase
        .execute({
          playerId,
          initialBalance: brl('100.00'),
          correlationId: uuid(),
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(Error);
      expect(await stored(playerId)).toEqual({
        wallets: 0,
        transactions: [],
        entries: [],
      });
    });
  });

  describe('PostgreSQL indisponível', () => {
    let downApp: INestApplication;
    let downUrl: string;

    beforeAll(async () => {
      ({ app: downApp, baseUrl: downUrl } = await startApp({
        databaseUrl: 'postgresql://wager:wager@127.0.0.1:1/wager',
      }));
    });

    afterAll(async () => {
      await downApp.close();
    });

    it.each([
      [
        'abertura',
        () =>
          fetch(`${downUrl}/wallets`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              playerId: uuid(),
              initialBalance: brl('1.00'),
            }),
          }),
      ],
      ['consulta', () => fetch(`${downUrl}/wallets/${uuid()}`)],
      ['extrato', () => fetch(`${downUrl}/wallets/${uuid()}/ledger`)],
      [
        'reconciliação',
        () =>
          fetch(`${downUrl}/wallets/${uuid()}/reconciliation`, {
            method: 'POST',
          }),
      ],
    ])('%s responde 503 com Retry-After', async (_caso, request) => {
      const response = await request();

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(await response.json()).toMatchObject({
        failureCode: FailureCode.INFRASTRUCTURE_UNAVAILABLE,
      });
    });
  });
});
