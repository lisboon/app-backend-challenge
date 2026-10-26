import { beforeEach, describe, expect, it } from 'bun:test';

import {
  DuplicateMessageError,
  MessageIdPayloadConflictError,
} from '../../../src/modules/@shared/domain/errors/inbox.errors';
import { InboxMessage } from '../../../src/modules/@shared/domain/inbox/inbox-message.entity';
import {
  TransactionContext,
  type TransactionManager,
} from '../../../src/modules/@shared/domain/transaction/transaction-manager';
import type { InboxMessageGateway } from '../../../src/modules/@shared/gateway/inbox-message.gateway';
import { InboxTransactionManager } from '../../../src/modules/@shared/usecase/inbox-transaction-manager';

const at = new Date('2026-10-25T12:00:00.000Z');
const hash = `v1:${'a'.repeat(64)}`;
const delivery = {
  consumerName: 'wager-transactions',
  messageId: 'msg-1',
  payloadHash: hash,
};

class FakeContext extends TransactionContext {
  constructor() {
    super();
  }
}

class FakeTransactions implements TransactionManager {
  executions = 0;

  snapshots = 0;

  constructor(private readonly inbox: FakeInbox) {}

  async execute<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T> {
    this.executions += 1;
    const committed = new Map(this.inbox.rows);
    try {
      return await work(new FakeContext());
    } catch (error) {
      this.inbox.rows = committed;
      throw error;
    }
  }

  snapshot<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T> {
    this.snapshots += 1;
    return work(new FakeContext());
  }
}

class FakeInbox implements InboxMessageGateway {
  rows = new Map<string, InboxMessage>();

  async create(message: InboxMessage): Promise<boolean> {
    if (this.rows.has(message.messageId)) {
      return false;
    }
    this.rows.set(message.messageId, message);
    return true;
  }

  async update(message: InboxMessage): Promise<void> {
    this.rows.set(message.messageId, message);
  }

  async findById(
    _consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    return this.rows.get(messageId) ?? null;
  }
}

describe('InboxTransactionManager', () => {
  let inbox: FakeInbox;
  let transactions: FakeTransactions;
  let manager: InboxTransactionManager;

  beforeEach(() => {
    inbox = new FakeInbox();
    transactions = new FakeTransactions(inbox);
    manager = new InboxTransactionManager(
      transactions,
      inbox,
      { now: () => at },
      delivery,
    );
  });

  it('registra a mensagem, executa o trabalho e marca processada na mesma transação', async () => {
    const result = await manager.execute(async () => 'ok');

    expect(result).toBe('ok');
    expect(transactions.executions).toBe(1);
    expect(inbox.rows.get('msg-1')?.isProcessed()).toBe(true);
  });

  it('falha no trabalho desfaz o registro da mensagem', async () => {
    const failure = await manager
      .execute(async () => {
        throw new Error('falhou');
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(inbox.rows.has('msg-1')).toBe(false);
  });

  it('uma nova tentativa registra a mensagem de novo e conclui', async () => {
    let attempts = 0;
    const work = async (): Promise<string> => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('corrida');
      }
      return 'ok';
    };

    await manager.execute(work).catch(() => undefined);
    const result = await manager.execute(work);

    expect(result).toBe('ok');
    expect(inbox.rows.get('msg-1')?.isProcessed()).toBe(true);
  });

  it('mensagem já processada com o mesmo conteúdo é duplicata e não executa o trabalho', async () => {
    await manager.execute(async () => 'primeira');
    let ran = false;

    const failure = await manager
      .execute(async () => {
        ran = true;
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DuplicateMessageError);
    expect(ran).toBe(false);
  });

  it('mesmo messageId com outro conteúdo é conflito', async () => {
    await manager.execute(async () => 'primeira');
    const other = new InboxTransactionManager(
      transactions,
      inbox,
      { now: () => at },
      { ...delivery, payloadHash: `v1:${'b'.repeat(64)}` },
    );

    const failure = await other
      .execute(async () => 'segunda')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MessageIdPayloadConflictError);
  });

  it('snapshot só repassa para o gerenciador real', async () => {
    const result = await manager.snapshot(async () => 'leitura');

    expect(result).toBe('leitura');
    expect(transactions.snapshots).toBe(1);
    expect(inbox.rows.size).toBe(0);
  });
});
