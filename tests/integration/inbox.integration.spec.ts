import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

import {
  entityManagerOf,
  MikroOrmTransactionManager,
} from '../../src/infra/database/mikro-orm-transaction-manager';
import {
  DuplicateMessageError,
  MessageIdPayloadConflictError,
} from '../../src/modules/@shared/domain/errors/inbox.errors';
import type { TransactionContext } from '../../src/modules/@shared/domain/transaction/transaction-manager';
import { InboxMessageRepository } from '../../src/modules/@shared/repository/inbox-message.repository';
import { InboxTransactionManager } from '../../src/modules/@shared/usecase/inbox-transaction-manager';
import { migrateFresh, openTestOrm } from '../support/database';

const uuid = (): string => Bun.randomUUIDv7();
const hash = (char: string): string => `v1:${char.repeat(64)}`;

describe('inbox com PostgreSQL real', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  const manager = (messageId: string, payloadHash = hash('a')) =>
    new InboxTransactionManager(
      new MikroOrmTransactionManager(orm),
      new InboxMessageRepository(),
      { now: () => new Date() },
      { consumerName: 'wager-transactions', messageId, payloadHash },
    );

  const recordEffect = (trx: TransactionContext, marker: string) =>
    entityManagerOf(trx).execute(
      "insert into outbox_messages (id,aggregate_id,event_type,payload,occurred_at,next_attempt_at) values (?,?,'InboxTest',?::jsonb,now(),now())",
      [uuid(), uuid(), JSON.stringify({ marker })],
    );

  const effects = async (marker: string): Promise<number> => {
    const [row] = await orm.em
      .fork()
      .execute<{ n: string }[]>(
        "select count(*) as n from outbox_messages where payload->>'marker' = ?",
        [marker],
      );
    return Number(row.n);
  };

  const inbox = async (messageId: string) =>
    (
      await orm.em
        .fork()
        .execute<{ processed: boolean }[]>(
          'select processed_at is not null as processed from inbox_messages where message_id = ?',
          [messageId],
        )
    )[0];

  it('registra a mensagem e o efeito na mesma transação', async () => {
    const messageId = uuid();

    await manager(messageId).execute((trx) => recordEffect(trx, messageId));

    expect(await effects(messageId)).toBe(1);
    expect(await inbox(messageId)).toEqual({ processed: true });
  });

  it('falha depois do registro desfaz a inbox e o efeito juntos', async () => {
    const messageId = uuid();

    const failure = await manager(messageId)
      .execute(async (trx) => {
        await recordEffect(trx, messageId);
        throw new Error('falha depois do efeito');
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(await effects(messageId)).toBe(0);
    expect(await inbox(messageId)).toBeUndefined();

    await manager(messageId).execute((trx) => recordEffect(trx, messageId));
    expect(await effects(messageId)).toBe(1);
  });

  it('reentrega da mesma mensagem é duplicata e não repete o efeito', async () => {
    const messageId = uuid();
    await manager(messageId).execute((trx) => recordEffect(trx, messageId));

    const failure = await manager(messageId)
      .execute((trx) => recordEffect(trx, messageId))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DuplicateMessageError);
    expect(await effects(messageId)).toBe(1);
  });

  it('mesmo messageId com outro conteúdo é conflito e não aplica', async () => {
    const messageId = uuid();
    await manager(messageId).execute((trx) => recordEffect(trx, messageId));

    const failure = await manager(messageId, hash('b'))
      .execute((trx) => recordEffect(trx, `${messageId}-outro`))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MessageIdPayloadConflictError);
    expect(await effects(`${messageId}-outro`)).toBe(0);
  });

  it('10 entregas simultâneas da mesma mensagem aplicam o efeito uma vez', async () => {
    const messageId = uuid();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        manager(messageId).execute(async (trx) => {
          await recordEffect(trx, messageId);
          await Bun.sleep(100);
          return 'aplicada';
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter(
        (r) =>
          r.status === 'rejected' && r.reason instanceof DuplicateMessageError,
      ),
    ).toHaveLength(9);
    expect(await effects(messageId)).toBe(1);
    expect(await inbox(messageId)).toEqual({ processed: true });
  });
});
