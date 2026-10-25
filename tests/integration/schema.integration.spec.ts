import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';

import { Money } from '../../src/modules/@shared/domain/money';
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
  resultBalance?: string | null;
  resultCurrency?: string | null;
}

const insertTransaction = (em: EntityManager, tx: TransactionRow) => {
  const kind = tx.kind ?? 'OPENING';

  const providerId =
    tx.providerId ?? (kind === 'OPENING' ? 'internal' : 'provider-a');

  const status = tx.status ?? 'PROCESSED';

  const terminal = ['PROCESSED', 'REJECTED', 'FAILED'].includes(status);

  const observed = ['PROCESSED', 'REJECTED'].includes(status);

  const resultBalance =
    tx.resultBalance === undefined
      ? observed
        ? '0.00'
        : null
      : tx.resultBalance;
  return em.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, currency, round_id, game_id, kind, amount, reference_external_transaction_id,
        status, failure_code, result_balance, result_currency, created_at, processed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ${terminal ? 'now()' : 'null'})`,
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
      resultBalance,
      resultBalance === null
        ? null
        : tx.resultCurrency === undefined
          ? 'BRL'
          : tx.resultCurrency,
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
          'wager_transactions.result_balance',
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
                       and tablename in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages'))
                  + (select count(*) from pg_proc
                      where proname like 'wallet%' or proname like 'wager%' or proname like 'outbox%') as n`,
            )
        )[0].n;

      await orm.migrator.down({ to: 0 });
      expect(Number(await objects())).toBe(0);

      await orm.migrator.up();
      expect(Number(await objects())).toBe(13);
    });

    it('reverter a última migration preserva rejeições gravadas em outra moeda', async () => {
      const opened = await openWallet('0.00', 'BRL');
      const rejectedId = uuid();
      await inTransaction((em) =>
        insertTransaction(em, {
          id: rejectedId,
          walletId: opened.walletId,
          playerId: opened.playerId,
          currency: 'USD',
          amount: '1.00',
          kind: 'BET',
          status: 'REJECTED',
          failureCode: 'CURRENCY_MISMATCH',
        }),
      );

      await orm.migrator.down({ to: 'Migration20261024000001Wallets' });
      const [{ n }] = await orm.em
        .fork()
        .getConnection()
        .execute<{ n: string }[]>(
          'select count(*) as n from wager_transactions where id = ?',
          [rejectedId],
        );
      await orm.migrator.up();

      expect(Number(n)).toBe(1);
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
    it.each([
      [
        'em moeda diferente da wallet',
        { currency: 'USD' },
        'CURRENCY_MISMATCH',
      ],
      ['de outro player', { playerId: uuid() }, 'WALLET_PLAYER_MISMATCH'],
    ])(
      'grava para auditoria a rejeição %s',
      async (_caso, overrides, failureCode) => {
        const opened = await openWallet('0.00', 'BRL');
        const id = uuid();
        await inTransaction((em) =>
          insertTransaction(em, {
            id,
            walletId: opened.walletId,
            playerId: opened.playerId,
            currency: 'BRL',
            amount: '1.00',
            kind: 'BET',
            status: 'REJECTED',
            failureCode,
            ...overrides,
          }),
        );
        const [row] = await orm.em
          .fork()
          .getConnection()
          .execute<{ status: string }[]>(
            'select status from wager_transactions where id = ?',
            [id],
          );

        expect(row.status).toBe('REJECTED');
      },
    );

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
        { kind: 'LOSS', failureCode: 'X' },
        'wager_tx_failure_ck',
      ],
      [
        'PROCESSED sem saldo observado',
        { kind: 'LOSS', resultBalance: null },
        'wager_tx_result_balance_ck',
      ],
      [
        'saldo observado sem moeda',
        { kind: 'LOSS', resultCurrency: null },
        'wager_tx_result_currency_ck',
      ],
      [
        'saldo observado em transação pendente',
        { kind: 'BET', status: 'PENDING', resultBalance: '1.00' },
        'wager_tx_result_balance_ck',
      ],
      [
        'BET de valor zero',
        { kind: 'BET', amount: '0.00', status: 'REJECTED', failureCode: 'X' },
        'wager_tx_positive_amount_ck',
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

    it('aceita LOSS processada de valor zero e sem lançamento', async () => {
      const opened = await openWallet('0.00');

      await inTransaction((em) =>
        insertTransaction(em, {
          id: uuid(),
          walletId: opened.walletId,
          playerId: opened.playerId,
          currency: 'BRL',
          amount: '0.00',
          kind: 'LOSS',
        }),
      );
    });

    it('idempotency key é única por provedor, não globalmente', async () => {
      const opened = await openWallet('0.00');
      const base = {
        walletId: opened.walletId,
        playerId: opened.playerId,
        currency: 'BRL',
        amount: '1.00',
        kind: 'LOSS',
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

  describe('transação e lançamento andam juntos', () => {
    interface Movement {
      kind?: string;
      status?: string;
      failureCode?: string | null;
      currency?: string;
      playerId?: string;
      direction?: string;
      amount?: string;
      entryAmount?: string;
      withEntry?: boolean;
    }

    const move = async (movement: Movement = {}): Promise<OpenedWallet> => {
      const opened = await openWallet('100.00');
      const kind = movement.kind ?? 'BET';
      const direction = movement.direction ?? 'DEBIT';
      const amount = movement.amount ?? '10.00';
      const entry = Money.from({
        amount: movement.entryAmount ?? amount,
        currency: 'BRL',
      });
      const before = Money.from({ amount: '100.00', currency: 'BRL' });
      const afterText = (
        direction === 'DEBIT' ? before.subtract(entry) : before.add(entry)
      ).toString();
      await inTransaction(async (em) => {
        const transactionId = uuid();
        await insertTransaction(em, {
          id: transactionId,
          walletId: opened.walletId,
          playerId: movement.playerId ?? opened.playerId,
          currency: movement.currency ?? 'BRL',
          amount,
          kind,
          status: movement.status,
          failureCode: movement.failureCode,
          resultBalance: afterText,
        });
        if (movement.withEntry ?? true) {
          await insertEntry(em, {
            walletId: opened.walletId,
            transactionId,
            direction,
            amount: entry.toString(),
            before: '100.00',
            after: afterText,
            version: 2,
          });
          await em.execute(
            'update wallets set balance = ?, version = 2 where id = ?',
            [afterText, opened.walletId],
          );
        }
      });
      return opened;
    };

    it('aceita BET processada com o débito correspondente', async () => {
      const opened = await move();

      expect(await ledgerMatchesBalance(orm, opened.walletId)).toEqual({
        stored: '90.00',
        rebuilt: '90.00',
      });
    });

    it.each([
      [
        'BET processada sem lançamento',
        { withEntry: false },
        'aplicada sem lançamento',
      ],
      [
        'lançamento de transação rejeitada',
        { status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' },
        'exige transação PROCESSED',
      ],
      ['lançamento de LOSS', { kind: 'LOSS' }, 'exige transação PROCESSED'],
      [
        'lançamento com valor diferente do da transação',
        { entryAmount: '9.99' },
        'diverge do valor, da moeda ou do player',
      ],
      [
        'lançamento de transação em outra moeda',
        { currency: 'USD' },
        'diverge do valor, da moeda ou do player',
      ],
      [
        'lançamento de transação de outro player',
        { playerId: uuid() },
        'diverge do valor, da moeda ou do player',
      ],
      ['crédito para uma BET', { direction: 'CREDIT' }, 'direção incompatível'],
      [
        'débito para um WIN',
        { kind: 'WIN', direction: 'DEBIT' },
        'direção incompatível',
      ],
    ])('recusa no commit %s', async (_caso, movement, message) => {
      const failure = await failureOf(() => move(movement));

      expect(failure.code).toBe('23514');
      expect(failure.message).toContain(message);
    });
  });

  describe('outbox_messages', () => {
    const insert = (em: EntityManager, id: string) =>
      em.execute(
        "insert into outbox_messages (id,aggregate_id,event_type,payload,occurred_at,next_attempt_at) values (?,?,'TestEvent','{}',now(),now())",
        [id, uuid()],
      );

    it('round-trip da migration da outbox preserva o schema anterior', async () => {
      await orm.migrator.down({ to: 'Migration20261024000002WagerSubmit' });
      const [absent] = await orm.em
        .fork()
        .execute<{ name: string | null }[]>(
          "select to_regclass('outbox_messages')::text as name",
        );
      expect(absent.name).toBeNull();
      await orm.migrator.up();
      const [present] = await orm.em
        .fork()
        .execute<{ name: string | null }[]>(
          "select to_regclass('outbox_messages')::text as name",
        );
      expect(present.name).toBe('outbox_messages');
    });

    it.each([
      'id',
      'aggregate_id',
      'event_type',
      'payload',
      'occurred_at',
      'attempts',
      'next_attempt_at',
    ])(
      'recusa null em %s e confere a constraint do catálogo',
      async (column) => {
        const values: Record<string, unknown> = {
          id: uuid(),
          aggregate_id: uuid(),
          event_type: 'TestEvent',
          payload: '{}',
          occurred_at: new Date(),
          attempts: 0,
          next_attempt_at: new Date(),
        };
        values[column] = null;
        const failure = await failureOf(() =>
          inTransaction((em) =>
            em.execute(
              'insert into outbox_messages (id,aggregate_id,event_type,payload,occurred_at,attempts,next_attempt_at) values (?,?,?,?,?,?,?)',
              Object.values(values),
            ),
          ),
        );
        expect(failure.code).toBe('23502');
        const name = 'outbox_messages_' + column + '_not_null';
        expect(
          await orm.em
            .fork()
            .execute<{ conname: string }[]>(
              "select conname from pg_constraint where conrelid='outbox_messages'::regclass and contype='n' and conname=?",
              [name],
            ),
        ).toEqual([{ conname: name }]);
      },
    );

    it('sequence é identity bigint única', async () => {
      const id = uuid();
      await inTransaction((em) => insert(em, id));
      const [row] = await orm.em
        .fork()
        .execute<{ sequence: string }[]>(
          'select sequence::text from outbox_messages where id=?',
          [id],
        );
      const failure = await failureOf(() =>
        inTransaction((em) =>
          em.execute(
            "insert into outbox_messages (id,aggregate_id,event_type,payload,occurred_at,next_attempt_at,sequence) overriding system value values (?,?,'TestEvent','{}',now(),now(),?)",
            [uuid(), uuid(), row.sequence],
          ),
        ),
      );
      expect(failure).toMatchObject({
        code: '23505',
        constraint: 'outbox_sequence_uk',
      });
      expect(
        await orm.em.fork().execute<
          {
            data_type: string;
            is_identity: string;
            identity_generation: string;
          }[]
        >("select data_type,is_identity,identity_generation from information_schema.columns where table_name='outbox_messages' and column_name='sequence'"),
      ).toEqual([
        {
          data_type: 'bigint',
          is_identity: 'YES',
          identity_generation: 'ALWAYS',
        },
      ]);
    });

    it('sequence não admite null e tem constraint nomeada', async () => {
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute(
              "insert into outbox_messages (id,aggregate_id,event_type,payload,occurred_at,next_attempt_at,sequence) overriding system value values (?,?,'TestEvent','{}',now(),now(),null)",
              [uuid(), uuid()],
            ),
          ),
        ),
      ).toMatchObject({ code: '23502' });
      expect(
        await orm.em
          .fork()
          .execute<{ conname: string }[]>(
            "select conname from pg_constraint where conrelid='outbox_messages'::regclass and conname='outbox_messages_sequence_not_null'",
          ),
      ).toEqual([{ conname: 'outbox_messages_sequence_not_null' }]);
    });

    it('recusa TRUNCATE com o nome do trigger', async () => {
      expect(
        await failureOf(() =>
          inTransaction((em) => em.execute('truncate outbox_messages')),
        ),
      ).toMatchObject({
        code: '23514',
        constraint: 'outbox_event_no_truncate',
      });
    });

    it('recusa chave duplicada', async () => {
      const id = uuid();
      await inTransaction((em) => insert(em, id));
      expect(
        await failureOf(() => inTransaction((em) => insert(em, id))),
      ).toMatchObject({ code: '23505', constraint: 'outbox_messages_pk' });
    });

    it.each([
      ['attempts = -1', 'outbox_attempts_ck'],
      [
        "published_at = occurred_at - interval '1 second'",
        'outbox_published_at_ck',
      ],
    ])('recusa %s', async (assignment, constraint) => {
      const id = uuid();
      await inTransaction((em) => insert(em, id));
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute(
              'update outbox_messages set ' + assignment + ' where id = ?',
              [id],
            ),
          ),
        ),
      ).toMatchObject({ code: '23514', constraint });
    });

    it.each([
      'id = gen_random_uuid()',
      'aggregate_id = gen_random_uuid()',
      "event_type = 'Outro'",
      'payload = \'{"alterado":true}\'::jsonb',
      "occurred_at = occurred_at + interval '1 second'",
      'sequence = DEFAULT',
    ])('recusa alteração do evento: %s', async (assignment) => {
      const id = uuid();
      await inTransaction((em) => insert(em, id));
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute(
              'update outbox_messages set ' + assignment + ' where id = ?',
              [id],
            ),
          ),
        ),
      ).toMatchObject({ code: '23514', constraint: 'outbox_event_immutable' });
    });

    it('recusa DELETE', async () => {
      const id = uuid();
      await inTransaction((em) => insert(em, id));
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute('delete from outbox_messages where id = ?', [id]),
          ),
        ),
      ).toMatchObject({ code: '23514', constraint: 'outbox_event_immutable' });
    });

    it('permite atualizar somente os metadados de publicação', async () => {
      const id = uuid();
      await inTransaction((em) => insert(em, id));
      await inTransaction((em) =>
        em.execute(
          "update outbox_messages set attempts=1,next_attempt_at=now()+interval '1 second',published_at=now(),last_error='TimeoutError' where id=?",
          [id],
        ),
      );
      const [row] = await orm.em
        .fork()
        .execute<{ attempts: number; last_error: string }[]>(
          'select attempts,last_error from outbox_messages where id=?',
          [id],
        );
      expect(row).toEqual({ attempts: 1, last_error: 'TimeoutError' });
    });
  });
});
