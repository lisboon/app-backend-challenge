import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';

import {
  failureOf,
  ledgerMatchesBalance,
  migrateFresh,
  openTestOrm,
} from '../support/database';

const HASH = `v1:${'a'.repeat(64)}`;
const uuid = (): string => Bun.randomUUIDv7();

interface OpenedWallet {
  walletId: string;
  playerId: string;
  openingId: string;
}

const insertWallet = (
  em: EntityManager,
  wallet: {
    id: string;
    playerId: string;
    currency: string;
    balance: string;
    version?: number;
  },
) =>
  em.execute('insert into wallets values (?, ?, ?, ?, ?, now(), now())', [
    wallet.id,
    wallet.playerId,
    wallet.currency,
    wallet.balance,
    wallet.version ?? 1,
  ]);

interface TransactionRow {
  id: string;
  walletId: string;
  playerId: string;
  currency: string;
  amount: string;
  kind?: string;
  providerId?: string;
  idempotencyKey?: string;
  roundId?: string | null;
  status?: string;
  failureCode?: string | null;
  referenceExternalTransactionId?: string | null;
}

const insertTransaction = (em: EntityManager, tx: TransactionRow) => {
  const kind = tx.kind ?? 'OPENING';
  const providerId =
    tx.providerId ?? (kind === 'OPENING' ? 'internal' : 'provider-a');
  const status = tx.status ?? 'PROCESSED';
  const terminal = ['PROCESSED', 'REJECTED', 'FAILED'].includes(status);
  return em.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, currency, round_id, game_id, kind, amount, reference_external_transaction_id,
        status, failure_code, created_at, processed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ${terminal ? 'now()' : 'null'})`,
    [
      tx.id,
      providerId,
      `ext-${tx.id}`,
      tx.idempotencyKey ?? `${providerId}:ext-${tx.id}`,
      HASH,
      tx.walletId,
      tx.playerId,
      tx.currency,
      tx.roundId === undefined
        ? kind === 'OPENING'
          ? null
          : 'round-1'
        : tx.roundId,
      kind === 'OPENING' ? null : 'game-1',
      kind,
      tx.amount,
      tx.referenceExternalTransactionId ?? null,
      status,
      tx.failureCode ?? null,
    ],
  );
};

const insertEntry = (
  em: EntityManager,
  entry: {
    walletId: string;
    transactionId: string;
    direction: string;
    amount: string;
    before: string;
    after: string;
    version: number;
  },
) =>
  em.execute(
    'insert into wallet_ledger_entries values (?, ?, ?, ?, ?, ?, ?, ?, now())',
    [
      uuid(),
      entry.walletId,
      entry.transactionId,
      entry.direction,
      entry.amount,
      entry.before,
      entry.after,
      entry.version,
    ],
  );

describe('schema (integração com PostgreSQL real)', () => {
  let orm: MikroORM;

  const inTransaction = (work: (em: EntityManager) => Promise<unknown>) =>
    orm.em.fork().transactional(work);

  const openWallet = async (
    balance = '100.00',
    currency = 'BRL',
  ): Promise<OpenedWallet> => {
    const opened = { walletId: uuid(), playerId: uuid(), openingId: uuid() };
    await inTransaction(async (em) => {
      await insertWallet(em, {
        id: opened.walletId,
        playerId: opened.playerId,
        currency,
        balance,
      });
      if (balance !== '0.00') {
        await insertTransaction(em, {
          id: opened.openingId,
          walletId: opened.walletId,
          playerId: opened.playerId,
          currency,
          amount: balance,
        });
        await insertEntry(em, {
          walletId: opened.walletId,
          transactionId: opened.openingId,
          direction: 'CREDIT',
          amount: balance,
          before: '0.00',
          after: balance,
          version: 1,
        });
      }
    });
    return opened;
  };

  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  describe('tipos monetários', () => {
    it('toda coluna de valor é NUMERIC(20,2), nenhuma é ponto flutuante', async () => {
      const columns = await orm.em
        .fork()
        .getConnection()
        .execute<
          {
            column: string;
            data_type: string;
            numeric_precision: number;
            numeric_scale: number;
          }[]
        >(
          `select table_name || '.' || column_name as column, data_type, numeric_precision, numeric_scale
             from information_schema.columns
            where table_schema = 'public'
              and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries')
              and data_type in ('numeric', 'real', 'double precision', 'money')
            order by 1`,
        );

      expect(columns).toEqual(
        [
          'wager_transactions.amount',
          'wallet_ledger_entries.amount',
          'wallet_ledger_entries.balance_after',
          'wallet_ledger_entries.balance_before',
          'wallets.balance',
        ].map((column) => ({
          column,
          data_type: 'numeric',
          numeric_precision: 20,
          numeric_scale: 2,
        })),
      );
    });
  });

  describe('migrations', () => {
    it('down remove tabelas e funções, e up as recria', async () => {
      const objects = async () =>
        (
          await orm.em
            .fork()
            .getConnection()
            .execute<{ n: string }[]>(
              `select (select count(*) from pg_tables where schemaname = 'public'
                       and tablename in ('wallets', 'wager_transactions', 'wallet_ledger_entries'))
                  + (select count(*) from pg_proc where proname like 'wallet%') as n`,
            )
        )[0].n;

      await orm.migrator.down({ to: 0 });
      expect(Number(await objects())).toBe(0);

      await orm.migrator.up();
      expect(Number(await objects())).toBe(8);
    });
  });

  describe('wallets', () => {
    it('aceita wallet aberta com saldo e o lançamento correspondente', async () => {
      const { walletId } = await openWallet('100.00');

      expect(await ledgerMatchesBalance(orm, walletId)).toEqual({
        stored: '100.00',
        rebuilt: '100.00',
      });
    });

    it('aceita wallet aberta com zero e sem lançamento', async () => {
      const { walletId } = await openWallet('0.00');

      expect(await ledgerMatchesBalance(orm, walletId)).toEqual({
        stored: '0.00',
        rebuilt: '0.00',
      });
    });

    it('recusa saldo negativo', async () => {
      const failure = await failureOf(() =>
        inTransaction((em) =>
          insertWallet(em, {
            id: uuid(),
            playerId: uuid(),
            currency: 'BRL',
            balance: '-0.01',
          }),
        ),
      );

      expect(failure).toMatchObject({
        code: '23514',
        constraint: 'wallets_balance_ck',
      });
    });

    it('recusa segunda wallet para o mesmo player e moeda', async () => {
      const { playerId } = await openWallet('0.00');
      const failure = await failureOf(() =>
        inTransaction((em) =>
          insertWallet(em, {
            id: uuid(),
            playerId,
            currency: 'BRL',
            balance: '0.00',
          }),
        ),
      );

      expect(failure).toMatchObject({
        code: '23505',
        constraint: 'wallets_player_currency_uk',
      });
    });

    it('aceita wallets de moedas diferentes para o mesmo player', async () => {
      const { playerId } = await openWallet('0.00', 'BRL');

      await inTransaction((em) =>
        insertWallet(em, {
          id: uuid(),
          playerId,
          currency: 'USD',
          balance: '0.00',
        }),
      );
    });

    it('recusa moeda fora do formato ISO-4217', async () => {
      const failure = await failureOf(() =>
        inTransaction((em) =>
          insertWallet(em, {
            id: uuid(),
            playerId: uuid(),
            currency: 'brl',
            balance: '0.00',
          }),
        ),
      );

      expect(failure).toMatchObject({
        code: '23514',
        constraint: 'wallets_currency_ck',
      });
    });

    it('recusa no commit saldo sem lançamento correspondente', async () => {
      const failure = await failureOf(() =>
        inTransaction((em) =>
          insertWallet(em, {
            id: uuid(),
            playerId: uuid(),
            currency: 'BRL',
            balance: '100.00',
          }),
        ),
      );

      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('diverge do ledger');
    });

    it('recusa no commit alteração de saldo sem lançamento', async () => {
      const { walletId } = await openWallet('100.00');
      const failure = await failureOf(() =>
        inTransaction((em) =>
          em.execute("update wallets set balance = '80.00' where id = ?", [
            walletId,
          ]),
        ),
      );

      expect(failure.code).toBe('23514');
      expect(await ledgerMatchesBalance(orm, walletId)).toEqual({
        stored: '100.00',
        rebuilt: '100.00',
      });
    });
  });

  describe('wallet_ledger_entries', () => {
    it.each([
      [
        'UPDATE',
        (id: string) =>
          `update wallet_ledger_entries set amount = amount where wallet_id = '${id}'`,
      ],
      [
        'DELETE',
        (id: string) =>
          `delete from wallet_ledger_entries where wallet_id = '${id}'`,
      ],
      ['TRUNCATE', () => 'truncate wallet_ledger_entries'],
    ])('é append-only: recusa %s', async (_caso, sql) => {
      const { walletId } = await openWallet('10.00');
      const failure = await failureOf(() =>
        orm.em.fork().getConnection().execute(sql(walletId)),
      );

      expect(failure.code).toBe('P0001');
    });

    it('recusa lançamento com aritmética errada', async () => {
      const failure = await failureOf(() =>
        inTransaction(async (em) => {
          const walletId = uuid();
          const playerId = uuid();
          const openingId = uuid();
          await insertWallet(em, {
            id: walletId,
            playerId,
            currency: 'BRL',
            balance: '100.00',
          });
          await insertTransaction(em, {
            id: openingId,
            walletId,
            playerId,
            currency: 'BRL',
            amount: '100.00',
          });
          await insertEntry(em, {
            walletId,
            transactionId: openingId,
            direction: 'CREDIT',
            amount: '100.00',
            before: '0.00',
            after: '100.01',
            version: 1,
          });
        }),
      );

      expect(failure).toMatchObject({
        code: '23514',
        constraint: 'ledger_arithmetic_ck',
      });
    });

    it('recusa dois lançamentos com a mesma versão da wallet', async () => {
      const opened = await openWallet('100.00');
      const failure = await failureOf(() =>
        inTransaction(async (em) => {
          const betId = uuid();
          await insertTransaction(em, {
            id: betId,
            walletId: opened.walletId,
            playerId: opened.playerId,
            currency: 'BRL',
            amount: '10.00',
            kind: 'BET',
          });
          await insertEntry(em, {
            walletId: opened.walletId,
            transactionId: betId,
            direction: 'DEBIT',
            amount: '10.00',
            before: '100.00',
            after: '90.00',
            version: 1,
          });
        }),
      );

      expect(failure).toMatchObject({
        code: '23505',
        constraint: 'ledger_wallet_version_uk',
      });
    });

    it('recusa no commit lançamento que não continua o saldo anterior', async () => {
      const opened = await openWallet('100.00');
      const failure = await failureOf(() =>
        inTransaction(async (em) => {
          const betId = uuid();
          await insertTransaction(em, {
            id: betId,
            walletId: opened.walletId,
            playerId: opened.playerId,
            currency: 'BRL',
            amount: '10.00',
            kind: 'BET',
          });
          await insertEntry(em, {
            walletId: opened.walletId,
            transactionId: betId,
            direction: 'DEBIT',
            amount: '10.00',
            before: '50.00',
            after: '40.00',
            version: 2,
          });
          await em.execute(
            "update wallets set balance = '40.00', version = 2 where id = ?",
            [opened.walletId],
          );
        }),
      );

      expect(failure.code).toBe('23514');
      expect(failure.message).toContain('não continua o saldo anterior');
    });

    it('aceita débito que continua o saldo e atualiza a wallet', async () => {
      const opened = await openWallet('100.00');
      await inTransaction(async (em) => {
        const betId = uuid();
        await insertTransaction(em, {
          id: betId,
          walletId: opened.walletId,
          playerId: opened.playerId,
          currency: 'BRL',
          amount: '80.00',
          kind: 'BET',
        });
        await insertEntry(em, {
          walletId: opened.walletId,
          transactionId: betId,
          direction: 'DEBIT',
          amount: '80.00',
          before: '100.00',
          after: '20.00',
          version: 2,
        });
        await em.execute(
          "update wallets set balance = '20.00', version = 2 where id = ?",
          [opened.walletId],
        );
      });

      expect(await ledgerMatchesBalance(orm, opened.walletId)).toEqual({
        stored: '20.00',
        rebuilt: '20.00',
      });
    });

    it('recusa lançamento de uma transação que pertence a outra wallet', async () => {
      const first = await openWallet('100.00');
      const second = await openWallet('0.00');
      const failure = await failureOf(() =>
        inTransaction(async (em) => {
          await insertEntry(em, {
            walletId: second.walletId,
            transactionId: first.openingId,
            direction: 'CREDIT',
            amount: '100.00',
            before: '0.00',
            after: '100.00',
            version: 1,
          });
        }),
      );

      expect(failure).toMatchObject({
        code: '23503',
        constraint: 'ledger_transaction_fk',
      });
    });
  });

  describe('wager_transactions', () => {
    it('recusa transação em moeda diferente da wallet', async () => {
      const opened = await openWallet('0.00', 'BRL');
      const failure = await failureOf(() =>
        inTransaction((em) =>
          insertTransaction(em, {
            id: uuid(),
            walletId: opened.walletId,
            playerId: opened.playerId,
            currency: 'USD',
            amount: '1.00',
            kind: 'BET',
          }),
        ),
      );

      expect(failure).toMatchObject({
        code: '23503',
        constraint: 'wager_tx_wallet_fk',
      });
    });

    it('recusa transação de outro player na wallet', async () => {
      const opened = await openWallet('0.00');
      const failure = await failureOf(() =>
        inTransaction((em) =>
          insertTransaction(em, {
            id: uuid(),
            walletId: opened.walletId,
            playerId: uuid(),
            currency: 'BRL',
            amount: '1.00',
            kind: 'BET',
          }),
        ),
      );

      expect(failure).toMatchObject({
        code: '23503',
        constraint: 'wager_tx_wallet_fk',
      });
    });

    it.each([
      [
        'OPENING de provedor externo',
        { kind: 'OPENING', providerId: 'provider-a' },
      ],
      ['BET do provedor interno', { kind: 'BET', providerId: 'internal' }],
    ])(
      'reserva o provedor interno para OPENING: recusa %s',
      async (_caso, overrides) => {
        const opened = await openWallet('0.00');
        const failure = await failureOf(() =>
          inTransaction((em) =>
            insertTransaction(em, {
              id: uuid(),
              walletId: opened.walletId,
              playerId: opened.playerId,
              currency: 'BRL',
              amount: '1.00',
              ...overrides,
            }),
          ),
        );

        expect(failure).toMatchObject({
          code: '23514',
          constraint: 'wager_tx_internal_ck',
        });
      },
    );

    it.each([
      ['BET sem rodada', { kind: 'BET', roundId: null }, 'wager_tx_round_ck'],
      [
        'REFUND sem referência',
        { kind: 'REFUND' },
        'wager_tx_reference_required_ck',
      ],
      [
        'REJECTED sem failure_code',
        { kind: 'BET', status: 'REJECTED' },
        'wager_tx_failure_ck',
      ],
      [
        'PROCESSED com failure_code',
        { kind: 'BET', failureCode: 'X' },
        'wager_tx_failure_ck',
      ],
      ['kind desconhecido', { kind: 'BONUS' }, 'wager_tx_kind_ck'],
    ])('recusa %s', async (_caso, overrides, constraint) => {
      const opened = await openWallet('0.00');
      const failure = await failureOf(() =>
        inTransaction((em) =>
          insertTransaction(em, {
            id: uuid(),
            walletId: opened.walletId,
            playerId: opened.playerId,
            currency: 'BRL',
            amount: '1.00',
            ...overrides,
          }),
        ),
      );

      expect(failure).toMatchObject({ code: '23514', constraint });
    });

    it('idempotency key é única por provedor, não globalmente', async () => {
      const opened = await openWallet('0.00');
      const base = {
        walletId: opened.walletId,
        playerId: opened.playerId,
        currency: 'BRL',
        amount: '1.00',
        kind: 'BET',
        idempotencyKey: 'shared-key',
      };
      await inTransaction(async (em) => {
        await insertTransaction(em, {
          ...base,
          id: uuid(),
          providerId: 'provider-a',
        });
        await insertTransaction(em, {
          ...base,
          id: uuid(),
          providerId: 'provider-b',
        });
      });
      const failure = await failureOf(() =>
        inTransaction((em) =>
          insertTransaction(em, {
            ...base,
            id: uuid(),
            providerId: 'provider-a',
          }),
        ),
      );

      expect(failure).toMatchObject({
        code: '23505',
        constraint: 'wager_tx_idempotency_uk',
      });
    });
  });
});
