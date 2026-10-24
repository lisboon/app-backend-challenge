import { beforeAll, afterAll, describe, it, expect, spyOn } from 'bun:test';
import { Logger, type INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Registry } from 'prom-client';

import { startApp } from '../support/http-app';
import {
  openTestOrm,
  migrateFresh,
  ledgerMatchesBalance,
  failureOf,
} from '../support/database';
import { debitWallet } from '../support/ledger';
import {
  MikroOrmTransactionManager,
  entityManagerOf,
} from '../../src/infra/database/mikro-orm-transaction-manager';
import { WalletRepository } from '../../src/modules/wallet/repository/wallet.repository';
import { LedgerRepository } from '../../src/modules/wallet/repository/ledger.repository';
import { ReconcileWalletUseCase } from '../../src/modules/wallet/usecase/reconcile-wallet/reconcile-wallet.usecase';

describe('reconciliação com infraestrutura real', () => {
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

  const open = async (amount = '100.00') => {
    const response = await fetch(baseUrl + '/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount, currency: 'BRL' },
      }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };

  const reconcile = (id: string) =>
    fetch(baseUrl + '/wallets/' + id + '/reconciliation', { method: 'POST' });

  const invariant = async (id: string) => {
    const balance = await ledgerMatchesBalance(orm, id);
    expect(balance.stored).toBe(balance.rebuilt);
  };

  const metric = async () => {
    const response = await fetch(baseUrl + '/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      app.get(Registry).contentType,
    );
    return response.text();
  };

  it('wallet zero tem reconciliação consistente sem entradas', async () => {
    const id = await open('0.00');
    expect(await (await reconcile(id)).json()).toEqual({
      walletId: id,
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
    await invariant(id);
  });

  it.each(['reconciliation'])('valida id e existência em %s', async (route) => {
    for (const [id, status, code] of [
      ['abc', 400, 'REQUEST_INVALID'],
      [Bun.randomUUIDv7(), 404, 'WALLET_NOT_FOUND'],
    ] as const) {
      const response = await fetch(baseUrl + '/wallets/' + id + '/' + route, {
        method: 'POST',
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ failureCode: code });
    }
  });

  it('reconcilia vários lançamentos sem log nem incremento quando consistente', async () => {
    const id = await open();
    await debitWallet(orm, id);
    await debitWallet(orm, id);
    const before = await metric();
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const response = await reconcile(id);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 3,
      });
      expect(warn).not.toHaveBeenCalled();
      expect(await metric()).toBe(before);
    } finally {
      warn.mockRestore();
    }
    await invariant(id);
  });

  it.each([
    ['105.00', '5.00'],
    ['95.00', '-5.00'],
  ])('detecta saldo adulterado %s sem corrigir', async (amount, difference) => {
    const id = await open();
    const before = await metric();
    const count = Number(
      before.match(/wallet_reconciliation_divergences_total (\d+)/)?.[1],
    );
    await orm.em.fork().transactional(async (em) => {
      await em.execute('set local session_replication_role = replica');
      await em.execute('update wallets set balance=?::numeric where id=?', [
        amount,
        id,
      ]);
    });
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const response = await reconcile(id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        walletId: id,
        storedBalance: { amount, currency: 'BRL' },
        calculatedBalance: { amount: '100.00', currency: 'BRL' },
        difference: { amount: difference, currency: 'BRL' },
        consistent: false,
        checkedEntries: 1,
      });
      expect(warn).toHaveBeenCalledWith({
        walletId: id,
        difference: { amount: difference, currency: 'BRL' },
        checkedEntries: 1,
      });
      expect(await ledgerMatchesBalance(orm, id)).toEqual({
        stored: amount,
        rebuilt: '100.00',
      });
      expect(await metric()).toContain(
        'wallet_reconciliation_divergences_total ' + (count + 1),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('saldo e soma usam o mesmo snapshot durante débito concorrente', async () => {
    const id = await open();
    const ledger = new LedgerRepository();
    const original = ledger.sumByWallet.bind(ledger);
    ledger.sumByWallet = async (walletId, currency, trx) => {
      await debitWallet(orm, id);
      return original(walletId, currency, trx);
    };
    const monitor = {
      divergenceDetected: () => {
        throw new Error('divergência falsa');
      },
    };
    const useCase = new ReconcileWalletUseCase(
      new MikroOrmTransactionManager(orm),
      new WalletRepository(),
      ledger,
      monitor,
    );
    expect(await useCase.execute({ walletId: id })).toMatchObject({
      storedBalance: { amount: '100.00' },
      calculatedBalance: { amount: '100.00' },
      consistent: true,
      checkedEntries: 1,
    });
    await invariant(id);
  });

  it('preserva valores além da precisão de number na soma SQL', async () => {
    const id = await open('999999999999999999.99');
    expect(await (await reconcile(id)).json()).toMatchObject({
      storedBalance: { amount: '999999999999999999.99' },
      calculatedBalance: { amount: '999999999999999999.99' },
      difference: { amount: '0.00' },
      consistent: true,
      checkedEntries: 1,
    });
    await invariant(id);
  });

  it('expõe somente as métricas da wallet e da outbox em um registro por aplicação', async () => {
    const families = [...(await metric()).matchAll(/# TYPE (\w+)/g)]
      .map((match) => match[1])
      .sort();
    expect(families).toEqual([
      'outbox_lag_seconds',
      'outbox_publish_failures_total',
      'outbox_publish_retries_total',
      'outbox_published_total',
      'wallet_reconciliation_divergences_total',
    ]);
    const other = await startApp();
    try {
      const response = await fetch(other.baseUrl + '/metrics');
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        'wallet_reconciliation_divergences_total 0\n',
      );
    } finally {
      await other.app.close();
    }
  });

  it('reconstrói soma negativa de um ledger adulterado com Money', async () => {
    const id = await open();
    await debitWallet(orm, id, '10.00');
    await orm.em.fork().transactional(async (em) => {
      await em.execute('set local session_replication_role = replica');
      await em.execute(
        "delete from wallet_ledger_entries where wallet_id = ? and direction = 'CREDIT'",
        [id],
      );
    });
    const transactions = new MikroOrmTransactionManager(orm);
    const sum = await transactions.snapshot((trx) =>
      new LedgerRepository().sumByWallet(id, 'BRL', trx),
    );
    expect(sum.balance.toJSON()).toEqual({ amount: '-10.00', currency: 'BRL' });
    expect(sum.entries).toBe(1);
    expect(await ledgerMatchesBalance(orm, id)).toEqual({
      stored: '90.00',
      rebuilt: '-10.00',
    });
  });

  it('snapshot recusa escrita e usa REPEATABLE READ', async () => {
    const transactions = new MikroOrmTransactionManager(orm);
    await transactions.snapshot(async (trx) => {
      const [row] = await entityManagerOf(trx).execute<
        { transaction_isolation: string; transaction_read_only: string }[]
      >(
        "select current_setting('transaction_isolation') as transaction_isolation,current_setting('transaction_read_only') as transaction_read_only",
      );
      expect(row).toEqual({
        transaction_isolation: 'repeatable read',
        transaction_read_only: 'on',
      });
    });
    const failure = await failureOf(() =>
      transactions.snapshot((trx) =>
        entityManagerOf(trx).execute('update wallets set balance=balance'),
      ),
    );
    expect(failure.code).toBe('25006');
  });
});
