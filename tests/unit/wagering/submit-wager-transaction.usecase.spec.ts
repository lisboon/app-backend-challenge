import { beforeEach, describe, expect, it } from 'bun:test';

import type { OutboxMessage } from '../../../src/modules/@shared/domain/outbox/outbox-message.entity';
import type { OutboxGateway } from '../../../src/modules/@shared/gateway/outbox.gateway';
import { WalletNotFoundError } from '../../../src/modules/@shared/domain/errors/wallet-not-found.error';
import { FailureCode } from '../../../src/modules/@shared/domain/failure-code';
import { Money } from '../../../src/modules/@shared/domain/money';
import {
  TransactionContext,
  type TransactionManager,
} from '../../../src/modules/@shared/domain/transaction/transaction-manager';
import {
  IdempotencyPayloadConflictError,
  IdempotencyRaceError,
  TransactionKindNotSubmittableError,
} from '../../../src/modules/wagering/domain/errors/wagering.errors';
import {
  MovementDirection,
  WagerTransaction,
  WagerTransactionStatus,
} from '../../../src/modules/wagering/domain/wager-transaction.entity';
import type { WagerTransactionGateway } from '../../../src/modules/wagering/gateway/wager-transaction.gateway';
import type {
  LockedWallet,
  WalletMovement,
  WalletMovementGateway,
} from '../../../src/modules/wagering/gateway/wallet-movement.gateway';
import { SubmitWagerTransactionUseCase } from '../../../src/modules/wagering/usecase/submit-wager-transaction/submit-wager-transaction.usecase';
import type { SubmitWagerTransactionUseCaseInputDto } from '../../../src/modules/wagering/usecase/submit-wager-transaction/submit-wager-transaction.usecase.dto';

const at = new Date('2026-10-24T12:00:00.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

class FakeContext extends TransactionContext {
  constructor() {
    super();
  }
}

class FakeWallets implements WalletMovementGateway {
  balance = brl('100.00');

  exists = true;

  readonly applied: WalletMovement[] = [];

  async lock(walletId: string): Promise<LockedWallet | null> {
    if (!this.exists) {
      return null;
    }
    return {
      id: walletId,
      playerId: 'player-1',
      currency: 'BRL',
      balance: this.balance,
      apply: async (movement) => {
        this.applied.push(movement);
        this.balance =
          movement.direction === MovementDirection.Debit
            ? this.balance.subtract(movement.money)
            : this.balance.add(movement.money);
        return {
          balance: this.balance,
          recordBalanceChanged: async () => undefined,
        };
      },
    };
  }
}

class FakeWagers implements WagerTransactionGateway {
  readonly stored: WagerTransaction[] = [];

  readonly committedElsewhere: WagerTransaction[] = [];

  beforeCreate: (transaction: WagerTransaction) => void = () => undefined;

  async create(transaction: WagerTransaction): Promise<void> {
    this.beforeCreate(transaction);
    this.stored.push(transaction);
  }

  private all(): WagerTransaction[] {
    return [...this.committedElsewhere, ...this.stored];
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.all().find((t) => t.id === id) ?? null;
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.all().find(
        (t) =>
          t.providerId === providerId && t.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.all().find(
        (t) =>
          t.providerId === providerId &&
          t.externalTransactionId === externalTransactionId,
      ) ?? null
    );
  }
}

class FakeOutbox implements OutboxGateway {
  readonly messages: OutboxMessage[] = [];

  async create(message: OutboxMessage): Promise<void> {
    this.messages.push(message);
  }
}

class FakeTransactions implements TransactionManager {
  executions = 0;

  constructor(
    private readonly wallets: FakeWallets,
    private readonly wagers: FakeWagers,
    private readonly outbox: FakeOutbox,
  ) {}

  async execute<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T> {
    this.executions += 1;
    const balance = this.wallets.balance;
    const stored = [...this.wagers.stored];
    const messages = [...this.outbox.messages];
    try {
      return await work(new FakeContext());
    } catch (error) {
      this.wallets.balance = balance;
      this.outbox.messages.splice(0, this.outbox.messages.length, ...messages);
      this.wagers.stored.splice(0, this.wagers.stored.length, ...stored);
      throw error;
    }
  }

  snapshot<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T> {
    return this.execute(work);
  }
}

const input = (
  overrides: Partial<SubmitWagerTransactionUseCaseInputDto> = {},
): SubmitWagerTransactionUseCaseInputDto => ({
  correlationId: 'correlation-1',
  idempotencyKey: 'provider-a:ext-1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '30.00', currency: 'BRL' },
  ...overrides,
});

describe('SubmitWagerTransactionUseCase', () => {
  let outbox: FakeOutbox;
  let wallets: FakeWallets;
  let wagers: FakeWagers;
  let transactions: FakeTransactions;
  let useCase: SubmitWagerTransactionUseCase;

  beforeEach(() => {
    wallets = new FakeWallets();
    wagers = new FakeWagers();
    outbox = new FakeOutbox();
    transactions = new FakeTransactions(wallets, wagers, outbox);
    let sequence = 0;
    useCase = new SubmitWagerTransactionUseCase(
      transactions,
      wagers,
      wallets,
      { next: () => `id-${(sequence += 1)}` },
      { now: () => at },
      outbox,
    );
  });

  it('BET com saldo debita, grava PROCESSED e devolve o saldo resultante', async () => {
    const output = await useCase.execute(input());

    expect(output).toEqual({
      transactionId: 'id-1',
      status: WagerTransactionStatus.Processed,
      failureCode: null,
      balance: { amount: '70.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(wallets.applied).toEqual([
      {
        transactionId: 'id-1',
        entryId: 'id-4',
        eventContext: {
          eventId: 'id-3',
          correlationId: 'correlation-1',
          causationId: 'id-2',
          occurredAt: at,
        },
        direction: MovementDirection.Debit,
        money: brl('30.00'),
        at,
      },
    ]);
    expect(wagers.stored.map((t) => t.status)).toEqual([
      WagerTransactionStatus.Processed,
    ]);
  });

  it('WIN credita', async () => {
    const output = await useCase.execute(input({ kind: 'WIN' }));

    expect(output.balance).toEqual({ amount: '130.00', currency: 'BRL' });
    expect(wallets.applied[0].direction).toBe(MovementDirection.Credit);
  });

  it('LOSS grava PROCESSED sem movimentar a wallet', async () => {
    const output = await useCase.execute(
      input({ kind: 'LOSS', money: { amount: '5.00', currency: 'BRL' } }),
    );

    expect(output.status).toBe(WagerTransactionStatus.Processed);
    expect(output.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallets.applied).toHaveLength(0);
  });

  it('regra violada grava REJECTED com o saldo observado e não movimenta', async () => {
    wallets.balance = brl('29.99');

    const output = await useCase.execute(input());

    expect(output).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.INSUFFICIENT_BALANCE,
      balance: { amount: '29.99', currency: 'BRL' },
    });
    expect(wallets.applied).toHaveLength(0);
    expect(wagers.stored).toHaveLength(1);
  });

  it('wallet inexistente falha sem gravar', async () => {
    wallets.exists = false;

    expect(
      await useCase.execute(input()).catch((error: unknown) => error),
    ).toBeInstanceOf(WalletNotFoundError);
    expect(wagers.stored).toHaveLength(0);
  });

  it('pedido inválido falha antes de abrir transação', async () => {
    expect(
      await useCase
        .execute(input({ kind: 'OPENING' }))
        .catch((error: unknown) => error),
    ).toBeInstanceOf(TransactionKindNotSubmittableError);
    expect(transactions.executions).toBe(0);
  });

  it('reenvio idêntico devolve o original sem movimentar de novo', async () => {
    const first = await useCase.execute(input());
    await useCase.execute(
      input({ idempotencyKey: 'outra', externalTransactionId: 'ext-2' }),
    );

    const replay = await useCase.execute(input());

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(wallets.applied).toHaveLength(2);
  });

  it('mesma chave com outro payload é conflito', async () => {
    await useCase.execute(input());

    expect(
      await useCase
        .execute(input({ money: { amount: '31.00', currency: 'BRL' } }))
        .catch((error: unknown) => error),
    ).toBeInstanceOf(IdempotencyPayloadConflictError);
  });

  it('perdendo a corrida pela chave, refaz uma vez e devolve o vencedor', async () => {
    const winner = WagerTransaction.create({
      ...input(),
      id: 'winner',
      money: brl('30.00'),
      at,
    });
    winner.markProcessed(brl('70.00'), at);
    wagers.beforeCreate = () => {
      wagers.beforeCreate = () => undefined;
      wagers.committedElsewhere.push(winner);
      throw new IdempotencyRaceError();
    };

    const output = await useCase.execute(input());

    expect(output).toMatchObject({
      transactionId: 'winner',
      balance: { amount: '70.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect(transactions.executions).toBe(2);
    expect(wallets.balance.toString()).toBe('100.00');
  });

  it('refaz só uma vez', async () => {
    wagers.beforeCreate = () => {
      throw new IdempotencyRaceError();
    };

    expect(
      await useCase.execute(input()).catch((error: unknown) => error),
    ).toBeInstanceOf(IdempotencyRaceError);
  });

  it.each([
    ['BET', '30.00', 'WagerTransactionProcessed'],
    ['LOSS', '0.00', 'WagerTransactionProcessed'],
    ['BET', '101.00', 'WagerTransactionRejected'],
  ] as const)(
    'enfileira o evento de %s com valor %s',
    async (kind, amount, eventType) => {
      const output = await useCase.execute(
        input({ kind, money: { amount, currency: 'BRL' } }),
      );
      expect(outbox.messages).toHaveLength(1);
      expect(outbox.messages[0].payload).toMatchObject({
        eventId: 'id-2',
        aggregateId: 'wallet-1',
        correlationId: 'correlation-1',
        occurredAt: at.toISOString(),
        version: 1,
        eventType,
        data: {
          transactionId: output.transactionId,
          kind,
          status: output.status,
          money: { amount, currency: 'BRL' },
          balance: output.balance,
        },
      });
      if (kind === 'LOSS' || eventType === 'WagerTransactionRejected') {
        expect(wallets.applied).toHaveLength(0);
      }
      if (eventType === 'WagerTransactionRejected') {
        expect(outbox.messages[0].payload.data).toMatchObject({
          failureCode: FailureCode.INSUFFICIENT_BALANCE,
        });
      }
    },
  );

  it('replay não enfileira mesmo com nova correlação', async () => {
    await useCase.execute(input());
    await useCase.execute(input({ correlationId: 'outra-correlação' }));
    expect(outbox.messages).toHaveLength(1);
    expect(outbox.messages[0].payload.correlationId).toBe('correlation-1');
  });
});
