import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';

import { MikroOrmTransactionManager } from '../../src/infra/database/mikro-orm-transaction-manager';
import { Money } from '../../src/modules/@shared/domain/money';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction.entity';
import { WagerTransactionRepository } from '../../src/modules/wagering/repository/wager-transaction.repository';
import { deferred } from '../support/async';
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
  externalTransactionId?: string;
  idempotencyKey?: string;
  roundId?: string | null;
  status?: string;
  failureCode?: string | null;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date | null;
  correlationId?: string | null;
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
        status, failure_code, result_balance, result_currency, created_at, processed_at, correlation_id,
        reference_transaction_id, reference_attempts, next_reference_attempt_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ${terminal ? 'now()' : 'null'}, ?, ?, ?, ?)`,
    [
      tx.id,
      providerId,
      tx.externalTransactionId ?? `ext-${tx.id}`,
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
      tx.correlationId === undefined ? tx.id : tx.correlationId,
      tx.referenceTransactionId ?? null,
      tx.referenceAttempts ?? 0,
      tx.nextReferenceAttemptAt === undefined
        ? status === 'PENDING_REFERENCE'
          ? new Date()
          : null
        : tx.nextReferenceAttemptAt,
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
                       and tablename in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages', 'inbox_messages'))
                  + (select count(*) from pg_proc
                      where proname like 'wallet%' or proname like 'wager%' or proname like 'outbox%' or proname like 'inbox%') as n`,
            )
        )[0].n;

      await orm.migrator.down({ to: 0 });
      expect(Number(await objects())).toBe(0);

      await orm.migrator.up();
      expect(Number(await objects())).toBe(21);
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

  describe('referências e reversões', () => {
    const invariant = async (walletId: string) => {
      const balance = await ledgerMatchesBalance(orm, walletId);
      expect(balance.stored).toBe(balance.rebuilt);
    };
    const rawMove = async (
      opened: OpenedWallet,
      kind: string,
      referenceId?: string,
      overrides: Partial<TransactionRow> & { direction?: string } = {},
    ) => {
      const id = uuid();
      await inTransaction(async (em) => {
        const [wallet] = await em.execute<
          { balance: string; version: number }[]
        >('select balance::text,version from wallets where id=? for update', [
          opened.walletId,
        ]);
        const [reference] = referenceId
          ? await em.execute<
              { kind: string; external_transaction_id: string }[]
            >(
              'select kind,external_transaction_id from wager_transactions where id=?',
              [referenceId],
            )
          : [];
        const direction =
          overrides.direction ??
          (kind === 'BET' || (kind === 'ROLLBACK' && reference?.kind !== 'BET')
            ? 'DEBIT'
            : 'CREDIT');
        const money = Money.from({
          amount: overrides.amount ?? '25.00',
          currency: 'BRL',
        });
        const before = Money.from({ amount: wallet.balance, currency: 'BRL' });
        const after =
          direction === 'CREDIT' ? before.add(money) : before.subtract(money);
        await insertTransaction(em, {
          id,
          walletId: opened.walletId,
          playerId: opened.playerId,
          currency: 'BRL',
          amount: money.toString(),
          kind,
          referenceExternalTransactionId: reference?.external_transaction_id,
          referenceTransactionId: referenceId,
          resultBalance: after.toString(),
          ...overrides,
        });
        await insertEntry(em, {
          walletId: opened.walletId,
          transactionId: id,
          direction,
          amount: money.toString(),
          before: before.toString(),
          after: after.toString(),
          version: wallet.version + 1,
        });
        await em.execute('update wallets set balance=?,version=? where id=?', [
          after.toString(),
          wallet.version + 1,
          opened.walletId,
        ]);
      });
      await invariant(opened.walletId);
      return id;
    };
    const bet = async () => {
      const opened = await openWallet('100.00');
      return { opened, id: await rawMove(opened, 'BET') };
    };
    const pending = async (
      opened: OpenedWallet,
      overrides: Partial<TransactionRow> = {},
    ) => {
      const id = uuid();
      await inTransaction((em) =>
        insertTransaction(em, {
          id,
          walletId: opened.walletId,
          playerId: opened.playerId,
          currency: 'BRL',
          amount: '25.00',
          kind: 'REFUND',
          status: 'PENDING_REFERENCE',
          referenceExternalTransactionId: 'missing',
          ...overrides,
        }),
      );
      return id;
    };

    it.each([
      [
        'tentativas negativas',
        { referenceAttempts: -1 },
        'wager_tx_reference_attempts_ck',
      ],
      [
        'pendente sem próxima tentativa',
        { nextReferenceAttemptAt: null },
        'wager_tx_pending_reference_ck',
      ],
      [
        'próxima tentativa em estado comum',
        { kind: 'WIN', status: 'PENDING', nextReferenceAttemptAt: new Date() },
        'wager_tx_pending_reference_ck',
      ],
      [
        'pendente sem referência externa',
        { kind: 'WIN', referenceExternalTransactionId: null },
        'wager_tx_pending_reference_ck',
      ],
      [
        'BET com referência externa',
        { kind: 'BET', status: 'PENDING' },
        'wager_tx_reference_not_allowed_ck',
      ],
      [
        'referência interna em pendente',
        { referenceTransactionId: uuid() },
        'wager_tx_reference_state_ck',
      ],
      [
        'processada com externa sem interna',
        { status: 'PROCESSED' },
        'wager_tx_reference_state_ck',
      ],
    ] as const)('SQL cru recusa %s', async (_name, changes, constraint) => {
      const opened = await openWallet('100.00');
      expect(
        await failureOf(() => pending(opened, { ...changes })),
      ).toMatchObject({ code: '23514', constraint });
      await invariant(opened.walletId);
    });

    it('SQL cru recusa transação que referencia a si mesma', async () => {
      const opened = await openWallet('100.00');
      const id = uuid();
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            insertTransaction(em, {
              id,
              walletId: opened.walletId,
              playerId: opened.playerId,
              currency: 'BRL',
              amount: '25.00',
              kind: 'REFUND',
              status: 'PENDING_REFERENCE',
              referenceExternalTransactionId: `ext-${id}`,
            }),
          ),
        ),
      ).toMatchObject({
        code: '23514',
        constraint: 'wager_tx_reference_not_self_ck',
      });
    });

    it('correlation_id é obrigatório e tem NOT NULL nomeado', async () => {
      const opened = await openWallet('0.00');
      expect(
        await failureOf(() => pending(opened, { correlationId: null })),
      ).toMatchObject({ code: '23502' });
      const names = await orm.em
        .fork()
        .execute<{ conname: string }[]>(
          "select conname from pg_constraint where conrelid='wager_transactions'::regclass and conname='wager_transactions_correlation_id_not_null'",
        );
      expect(names).toEqual([
        { conname: 'wager_transactions_correlation_id_not_null' },
      ]);
      await invariant(opened.walletId);
    });

    it('FK composta recusa referência de outra wallet', async () => {
      const original = await bet();
      const other = await openWallet('100.00');
      expect(
        await failureOf(() => rawMove(other, 'REFUND', original.id)),
      ).toMatchObject({
        code: '23503',
        constraint: 'wager_tx_reference_wallet_fk',
      });
      await invariant(original.opened.walletId);
      await invariant(other.walletId);
    });

    it('índice único recusa duas reversões do mesmo tipo', async () => {
      const { opened, id } = await bet();
      await rawMove(opened, 'REFUND', id);
      expect(
        await failureOf(() => rawMove(opened, 'REFUND', id)),
      ).toMatchObject({
        code: '23505',
        constraint: 'wager_tx_single_reversal_uk',
      });
      await invariant(opened.walletId);
    });

    it.each(['create', 'update'] as const)(
      'repositório traduz o 23505 de reversão em %s',
      async (method) => {
        const { opened, id } = await bet();
        await rawMove(opened, 'REFUND', id);
        const transaction = WagerTransaction.create({
          correlationId: 'correlation',
          id: uuid(),
          providerId: 'provider-a',
          externalTransactionId: uuid(),
          idempotencyKey: uuid(),
          walletId: opened.walletId,
          playerId: opened.playerId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'REFUND',
          money: Money.from({ amount: '25.00', currency: 'BRL' }),
          at: new Date(),
          referenceExternalTransactionId: `ext-${id}`,
        });
        const repository = new WagerTransactionRepository();
        const manager = new MikroOrmTransactionManager(orm);
        if (method === 'update') {
          transaction.markPendingReference(new Date(), 3600);
          await manager.execute((trx) => repository.create(transaction, trx));
        }
        transaction.markProcessed(
          Money.from({ amount: '100.00', currency: 'BRL' }),
          new Date(),
          id,
        );
        const error: unknown = await manager
          .execute((trx) => repository[method](transaction, trx))
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({
          failureCode: 'REFERENCE_ALREADY_REVERSED',
        });
        await invariant(opened.walletId);
      },
    );

    it.each(['REFUND', 'ROLLBACK'] as const)(
      'trigger impede reversão líquida duplicada começando por %s',
      async (first) => {
        const { opened, id } = await bet();
        await rawMove(opened, first, id);
        const next = first === 'REFUND' ? 'ROLLBACK' : 'REFUND';
        expect(await failureOf(() => rawMove(opened, next, id))).toMatchObject({
          code: '23514',
          constraint: 'wager_transactions_single_net_reversal',
        });
        await invariant(opened.walletId);
      },
    );

    it.each(['REFUND', 'ROLLBACK'] as const)(
      'trigger impede WIN sobre BET revertido por %s',
      async (reversal) => {
        const { opened, id } = await bet();
        await rawMove(opened, reversal, id);
        expect(await failureOf(() => rawMove(opened, 'WIN', id))).toMatchObject(
          {
            code: '23514',
            constraint: 'wager_transactions_single_net_reversal',
          },
        );
        await invariant(opened.walletId);
      },
    );

    it('WIN sobre BET cujo REFUND foi desfeito é aceito', async () => {
      const { opened, id } = await bet();
      const refund = await rawMove(opened, 'REFUND', id);
      await rawMove(opened, 'ROLLBACK', refund);
      await rawMove(opened, 'WIN', id);
      await rawMove(opened, 'WIN', id);
      expect(await ledgerMatchesBalance(orm, opened.walletId)).toEqual({
        stored: '125.00',
        rebuilt: '125.00',
      });
    });

    it('REFUND desfeito permite ROLLBACK do BET e mantém saldo 100', async () => {
      const { opened, id } = await bet();
      const refund = await rawMove(opened, 'REFUND', id);
      await rawMove(opened, 'ROLLBACK', refund);
      await rawMove(opened, 'ROLLBACK', id);
      expect(await ledgerMatchesBalance(orm, opened.walletId)).toEqual({
        stored: '100.00',
        rebuilt: '100.00',
      });
    });

    it.each([
      ['estado', { status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' }],
      ['tipo', { kind: 'WIN' }],
      ['player', { playerId: uuid() }],
      ['moeda', { currency: 'USD' }],
      ['rodada', { roundId: 'other' }],
      ['provedor', { providerId: 'other' }],
      ['valor', { amount: '24.00' }],
    ] as const)(
      'trigger recusa referência com %s incompatível',
      async (field, change) => {
        const opened = await openWallet('100.00');
        let referenceId: string;
        if (field === 'estado') {
          referenceId = uuid();
          await inTransaction((em) =>
            insertTransaction(em, {
              id: referenceId,
              walletId: opened.walletId,
              playerId: opened.playerId,
              currency: 'BRL',
              amount: '25.00',
              kind: 'BET',
              ...change,
            }),
          );
        } else {
          referenceId = await rawMove(opened, field === 'tipo' ? 'WIN' : 'BET');
        }
        const overrides = field === 'estado' || field === 'tipo' ? {} : change;
        expect(
          await failureOf(() =>
            rawMove(opened, 'REFUND', referenceId, overrides),
          ),
        ).toMatchObject({
          code: '23514',
          constraint: 'wager_transactions_reference_valid',
        });
        await invariant(opened.walletId);
      },
    );

    it('trigger do ledger recusa crédito para ROLLBACK de WIN', async () => {
      const opened = await openWallet('100.00');
      const win = await rawMove(opened, 'WIN');
      expect(
        await failureOf(() =>
          rawMove(opened, 'ROLLBACK', win, { direction: 'CREDIT' }),
        ),
      ).toMatchObject({
        code: '23514',
        constraint: 'wallet_ledger_entries_match_transaction',
      });
      await invariant(opened.walletId);
    });

    it('índices de vencimento e aceleração são parciais para pendentes', async () => {
      const indexes = await orm.em
        .fork()
        .execute<{ indexname: string; indexdef: string }[]>(
          "select indexname,indexdef from pg_indexes where indexname in ('wager_tx_pending_due_idx','wager_tx_pending_reference_idx') order by indexname",
        );
      expect(indexes).toHaveLength(2);
      expect(indexes[0].indexdef).toContain('next_reference_attempt_at');
      expect(indexes[1].indexdef).toContain(
        'provider_id, reference_external_transaction_id',
      );
      expect(
        indexes.every((index) => index.indexdef.includes('PENDING_REFERENCE')),
      ).toBe(true);
    });

    it('round-trip com dados preserva transações e ledger e preenche correlação legada', async () => {
      const { opened, id } = await bet();
      const waiting = await pending(opened);
      await orm.migrator.down({ to: 'Migration20261024000004OutboxOrdering' });
      const before = await orm.em
        .fork()
        .execute<{ id: string }[]>(
          'select id from wager_transactions where id in (?,?) order by id',
          [id, waiting],
        );
      await orm.migrator.up();
      const after = await orm.em.fork().execute<
        {
          id: string;
          correlation_id: string;
          reference_attempts: number;
          next_reference_attempt_at: string | null;
        }[]
      >('select id,correlation_id,reference_attempts,next_reference_attempt_at from wager_transactions where id in (?,?) order by id', [id, waiting]);
      expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
      expect(
        after.every(
          (row) =>
            row.correlation_id === row.id && row.reference_attempts === 0,
        ),
      ).toBe(true);
      expect(
        after.find((row) => row.id === waiting)?.next_reference_attempt_at,
      ).not.toBeNull();
      await invariant(opened.walletId);
    });

    it('SQL cru permite pendência, retry sem transição e rejeição, mas não volta a PENDING', async () => {
      const opened = await openWallet('0.00');
      const id = await pending(opened, {
        status: 'PENDING',
        nextReferenceAttemptAt: null,
      });
      await inTransaction((em) =>
        em.execute(
          "update wager_transactions set status='PENDING_REFERENCE',next_reference_attempt_at=now() where id=?",
          [id],
        ),
      );
      await inTransaction((em) =>
        em.execute(
          "update wager_transactions set reference_attempts=1,next_reference_attempt_at=now()+interval '1 second' where id=?",
          [id],
        ),
      );
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute(
              "update wager_transactions set status='PENDING' where id=?",
              [id],
            ),
          ),
        ),
      ).toMatchObject({
        code: '23514',
        constraint: 'wager_transactions_protect',
      });
      await inTransaction((em) =>
        em.execute(
          "update wager_transactions set status='REJECTED',failure_code='REFERENCE_NOT_FOUND',result_balance=0,result_currency='BRL',next_reference_attempt_at=null,processed_at=now() where id=?",
          [id],
        ),
      );
      const [saved] = await orm.em
        .fork()
        .execute<{ status: string; reference_attempts: number }[]>(
          'select status,reference_attempts from wager_transactions where id=?',
          [id],
        );
      expect(saved).toEqual({ status: 'REJECTED', reference_attempts: 1 });
      await invariant(opened.walletId);
    });

    it('reverter a migration de FAILED volta a recusar PENDING_REFERENCE para FAILED', async () => {
      const opened = await openWallet('0.00');
      const before = await pending(opened);
      const after = await pending(opened);
      const fail = (id: string) =>
        inTransaction((em) =>
          em.execute(
            "update wager_transactions set status='FAILED',failure_code='PROCESSING_FAILED',next_reference_attempt_at=null,processed_at=now() where id=?",
            [id],
          ),
        );

      await orm.migrator.down({ to: 'Migration20261025000006Inbox' });
      const refused = await failureOf(() => fail(before));
      await orm.migrator.up();

      expect(refused).toMatchObject({
        code: '23514',
        constraint: 'wager_transactions_protect',
      });
      await fail(after);
    });

    it('lock de pendente ignora uma linha já travada sem depender do lock da wallet', async () => {
      const opened = await openWallet('0.00');
      const id = await pending(opened);
      const ready = deferred();
      const release = deferred();
      const holder = inTransaction(async (em) => {
        await em.execute(
          'select id from wager_transactions where id=? for update',
          [id],
        );
        ready.resolve();
        await release.promise;
      });
      await ready.promise;
      const captured = new MikroOrmTransactionManager(orm).execute((trx) =>
        new WagerTransactionRepository().lockPendingReference(id, trx),
      );
      try {
        expect(
          await Promise.race([captured, Bun.sleep(500).then(() => 'travou')]),
        ).toBeNull();
      } finally {
        release.resolve();
        await Promise.allSettled([holder, captured]);
      }
      await invariant(opened.walletId);
    });
  });

  describe('proteção de transações e identidade da wallet', () => {
    const row = async (status = 'PENDING') => {
      const opened = await openWallet('0.00');
      const id = uuid();
      await inTransaction((em) =>
        insertTransaction(em, {
          id,
          walletId: opened.walletId,
          playerId: opened.playerId,
          currency: 'BRL',
          amount: '0.00',
          kind: 'LOSS',
          status,
          failureCode:
            status === 'REJECTED' || status === 'FAILED'
              ? 'TEST_FAILURE'
              : null,
        }),
      );
      return { ...opened, id };
    };
    it.each(['PROCESSED', 'REJECTED', 'FAILED'])(
      'SQL cru recusa UPDATE terminal em %s, inclusive sem alteração',
      async (status) => {
        const { id, walletId } = await row(status);
        for (const assignment of [
          "status='PENDING'",
          'reference_attempts=reference_attempts',
        ]) {
          expect(
            await failureOf(() =>
              inTransaction((em) =>
                em.execute(
                  'update wager_transactions set ' + assignment + ' where id=?',
                  [id],
                ),
              ),
            ),
          ).toMatchObject({
            code: '23514',
            constraint: 'wager_transactions_protect',
          });
        }
        expect(await ledgerMatchesBalance(orm, walletId)).toEqual({
          stored: '0.00',
          rebuilt: '0.00',
        });
      },
    );
    it.each(['PENDING', 'PROCESSED', 'REJECTED', 'FAILED'])(
      'SQL cru recusa DELETE de %s',
      async (status) => {
        const { id } = await row(status);
        expect(
          await failureOf(() =>
            inTransaction((em) =>
              em.execute('delete from wager_transactions where id=?', [id]),
            ),
          ),
        ).toMatchObject({
          code: '23514',
          constraint: 'wager_transactions_protect',
        });
      },
    );
    it('SQL cru recusa TRUNCATE mesmo com CASCADE', async () => {
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute('truncate wager_transactions cascade'),
          ),
        ),
      ).toMatchObject({
        code: '23514',
        constraint: 'wager_transactions_no_truncate',
      });
    });
    it.each([
      ['id', "'00000000-0000-0000-0000-000000000001'"],
      ['provider_id', "'other-provider'"],
      ['external_transaction_id', "'other-external'"],
      ['idempotency_key', "'other-key'"],
      ['payload_hash', "'v1:" + 'b'.repeat(64) + "'"],
      ['wallet_id', "'00000000-0000-0000-0000-000000000001'"],
      ['player_id', "'00000000-0000-0000-0000-000000000001'"],
      ['currency', "'USD'"],
      ['round_id', "'other-round'"],
      ['game_id', "'other-game'"],
      ['kind', "'WIN'"],
      ['amount', "'1.00'"],
      ['reference_external_transaction_id', "'other-ref'"],
      ['created_at', "created_at+interval '1 second'"],
      ['correlation_id', "'other-correlation'"],
    ])(
      'SQL cru recusa mudar identidade %s de uma pendente',
      async (column, value) => {
        const { id } = await row();
        expect(
          await failureOf(() =>
            inTransaction((em) =>
              em.execute(
                'update wager_transactions set ' +
                  column +
                  '=' +
                  value +
                  ' where id=?',
                [id],
              ),
            ),
          ),
        ).toMatchObject({
          code: '23514',
          constraint: 'wager_transactions_protect',
        });
      },
    );
    it.each(['id', 'player_id', 'currency'])(
      'SQL cru recusa mudar %s da wallet',
      async (column) => {
        const { walletId } = await row();
        const value = column === 'currency' ? 'USD' : uuid();
        expect(
          await failureOf(() =>
            inTransaction((em) =>
              em.execute('update wallets set ' + column + '=? where id=?', [
                value,
                walletId,
              ]),
            ),
          ),
        ).toMatchObject({ code: '23514', constraint: 'wallets_protect' });
      },
    );
    it('SQL cru recusa FAILED com saldo observado', async () => {
      const { id } = await row();
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute(
              "update wager_transactions set status='FAILED',failure_code='TEST',result_balance=0,result_currency='BRL',processed_at=now() where id=?",
              [id],
            ),
          ),
        ),
      ).toMatchObject({ code: '23514' });
    });
    it('SQL cru permite PENDING para FAILED e depois o trata como terminal', async () => {
      const { id } = await row();
      await inTransaction((em) =>
        em.execute(
          "update wager_transactions set status='FAILED',failure_code='TEST',processed_at=now() where id=?",
          [id],
        ),
      );
      for (const change of [
        "status='PROCESSED',failure_code=null,result_balance=0,result_currency='BRL'",
        "failure_code='OTHER'",
      ]) {
        expect(
          await failureOf(() =>
            inTransaction((em) =>
              em.execute(
                'update wager_transactions set ' + change + ' where id=?',
                [id],
              ),
            ),
          ),
        ).toMatchObject({
          code: '23514',
          constraint: 'wager_transactions_protect',
        });
      }
    });
    it.each(['PROCESSED', 'REJECTED'])(
      'SQL cru permite PENDING para %s',
      async (status) => {
        const { id, walletId } = await row();
        await inTransaction((em) =>
          em.execute(
            "update wager_transactions set status=?,failure_code=?,result_balance=0,result_currency='BRL',processed_at=now() where id=?",
            [status, status === 'REJECTED' ? 'TEST' : null, id],
          ),
        );
        const [saved] = await orm.em
          .fork()
          .execute<{ status: string }[]>(
            'select status from wager_transactions where id=?',
            [id],
          );
        expect(saved.status).toBe(status);
        expect(await ledgerMatchesBalance(orm, walletId)).toEqual({
          stored: '0.00',
          rebuilt: '0.00',
        });
      },
    );
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
  describe('inbox_messages', () => {
    const insert = (em: EntityManager, messageId: string, hash = HASH) =>
      em.execute(
        "insert into inbox_messages (consumer_name,message_id,payload_hash,received_at) values ('wager-transactions',?,?,now())",
        [messageId, hash],
      );
    const processed = async (messageId: string): Promise<void> => {
      await inTransaction(async (em) => {
        await insert(em, messageId);
        await em.execute(
          'update inbox_messages set processed_at = received_at where message_id = ?',
          [messageId],
        );
      });
    };

    it('round-trip da migration da inbox preserva o schema anterior', async () => {
      await orm.migrator.down({ to: 'Migration20261025000005WagerReversals' });
      const [absent] = await orm.em
        .fork()
        .execute<{ name: string | null }[]>(
          "select to_regclass('inbox_messages')::text as name",
        );
      expect(absent.name).toBeNull();
      await orm.migrator.up();
      const [present] = await orm.em
        .fork()
        .execute<{ name: string | null }[]>(
          "select to_regclass('inbox_messages')::text as name",
        );
      expect(present.name).toBe('inbox_messages');
    });

    it('recusa o mesmo messageId duas vezes para o mesmo consumidor', async () => {
      const messageId = uuid();
      await inTransaction((em) => insert(em, messageId));
      expect(
        await failureOf(() => inTransaction((em) => insert(em, messageId))),
      ).toMatchObject({ code: '23505', constraint: 'inbox_messages_pk' });
    });

    it('recusa hash fora do formato', async () => {
      expect(
        await failureOf(() =>
          inTransaction((em) => insert(em, uuid(), 'sem-versao')),
        ),
      ).toMatchObject({ code: '23514', constraint: 'inbox_payload_hash_ck' });
    });

    it('recusa processamento anterior ao recebimento', async () => {
      const messageId = uuid();
      await inTransaction((em) => insert(em, messageId));
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute(
              "update inbox_messages set processed_at = received_at - interval '1 second' where message_id = ?",
              [messageId],
            ),
          ),
        ),
      ).toMatchObject({ code: '23514', constraint: 'inbox_processed_at_ck' });
    });

    it.each([
      "consumer_name = 'outro'",
      "message_id = 'outro'",
      "payload_hash = 'v1:" + 'b'.repeat(64) + "'",
      "received_at = received_at + interval '1 second'",
    ])('recusa alteração da identidade: %s', async (assignment) => {
      const messageId = uuid();
      await inTransaction((em) => insert(em, messageId));
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute(
              'update inbox_messages set ' +
                assignment +
                ' where message_id = ?',
              [messageId],
            ),
          ),
        ),
      ).toMatchObject({ code: '23514', constraint: 'inbox_message_immutable' });
    });

    it('recusa qualquer alteração depois de processada', async () => {
      const messageId = uuid();
      await processed(messageId);
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute(
              "update inbox_messages set processed_at = processed_at + interval '1 second' where message_id = ?",
              [messageId],
            ),
          ),
        ),
      ).toMatchObject({ code: '23514', constraint: 'inbox_message_immutable' });
    });

    it('recusa DELETE', async () => {
      const messageId = uuid();
      await processed(messageId);
      expect(
        await failureOf(() =>
          inTransaction((em) =>
            em.execute('delete from inbox_messages where message_id = ?', [
              messageId,
            ]),
          ),
        ),
      ).toMatchObject({ code: '23514', constraint: 'inbox_message_immutable' });
    });

    it('recusa TRUNCATE com o nome do trigger', async () => {
      expect(
        await failureOf(() =>
          inTransaction((em) => em.execute('truncate inbox_messages')),
        ),
      ).toMatchObject({
        code: '23514',
        constraint: 'inbox_message_no_truncate',
      });
    });

    it('permite marcar como processada uma única vez', async () => {
      const messageId = uuid();
      await processed(messageId);
      const [row] = await orm.em
        .fork()
        .execute<{ processed: boolean }[]>(
          'select processed_at is not null as processed from inbox_messages where message_id = ?',
          [messageId],
        );
      expect(row.processed).toBe(true);
    });
  });

  describe('FAILED não reserva o id externo', () => {
    const transactionWith = (
      opened: OpenedWallet,
      externalTransactionId: string,
      status: string,
    ): TransactionRow => ({
      id: uuid(),
      walletId: opened.walletId,
      playerId: opened.playerId,
      currency: 'BRL',
      amount: '1.00',
      kind: 'BET',
      externalTransactionId,
      idempotencyKey: uuid(),
      status,
      failureCode:
        status === 'FAILED' ? 'PROCESSING_FAILED' : 'INSUFFICIENT_BALANCE',
      resultBalance: status === 'FAILED' ? null : '0.00',
      resultCurrency: status === 'FAILED' ? null : 'BRL',
    });

    it('a busca por id externo usa índice mesmo quando só há FAILED ou nada', async () => {
      const plan = await inTransaction(async (em) => {
        await em.execute('set local enable_seqscan = off');
        return em.execute<{ 'QUERY PLAN': string }[]>(
          "explain select * from wager_transactions where provider_id = ? and external_transaction_id = ? order by status = 'FAILED', created_at desc limit 1",
          ['provider-a', uuid()],
        );
      });
      const text = (plan as { 'QUERY PLAN': string }[])
        .map((row) => row['QUERY PLAN'])
        .join('\n');

      expect(text).toContain('wager_tx_external_idx');
      expect(text).not.toContain('Seq Scan');
    });

    it('aceita FAILED e REJECTED com o mesmo id externo, mas não dois desfechos vivos', async () => {
      const opened = await openWallet('0.00');
      const externalTransactionId = uuid();
      for (const status of ['FAILED', 'FAILED', 'REJECTED']) {
        await inTransaction((em) =>
          insertTransaction(
            em,
            transactionWith(opened, externalTransactionId, status),
          ),
        );
      }

      expect(
        await failureOf(() =>
          inTransaction((em) =>
            insertTransaction(
              em,
              transactionWith(opened, externalTransactionId, 'REJECTED'),
            ),
          ),
        ),
      ).toMatchObject({ code: '23505', constraint: 'wager_tx_external_uk' });
    });

    it('reverter recusa quando há FAILED repetindo um id externo e restaura a constraint sem ele', async () => {
      const opened = await openWallet('0.00');
      const externalTransactionId = uuid();
      const failed = transactionWith(opened, externalTransactionId, 'FAILED');
      await inTransaction((em) => insertTransaction(em, failed));
      await inTransaction((em) =>
        insertTransaction(
          em,
          transactionWith(opened, externalTransactionId, 'REJECTED'),
        ),
      );

      expect(
        await failureOf(() =>
          orm.migrator.down({ to: 'Migration20261025000007FailedTransitions' }),
        ),
      ).toMatchObject({ message: expect.stringContaining('apagar auditoria') });

      await inTransaction(async (em) => {
        await em.execute('set local session_replication_role = replica');
        await em.execute(
          "delete from wager_transactions t where status = 'FAILED' and exists (select 1 from wager_transactions o where o.provider_id = t.provider_id and o.external_transaction_id = t.external_transaction_id and o.id <> t.id)",
        );
      });
      await orm.migrator.down({
        to: 'Migration20261025000007FailedTransitions',
      });
      const [constraint] = await orm.em
        .fork()
        .execute<{ type: string }[]>(
          "select contype as type from pg_constraint where conname = 'wager_tx_external_uk'",
        );
      expect(constraint).toEqual({ type: 'u' });
      await orm.migrator.up();
    });
  });
});
