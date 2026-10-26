import { beforeEach, describe, expect, it } from 'bun:test';

import { InfrastructureUnavailableError } from '../../../src/modules/@shared/domain/errors/infrastructure.errors';
import { FailureCode } from '../../../src/modules/@shared/domain/failure-code';
import { Money } from '../../../src/modules/@shared/domain/money';
import type { OutboxMessage } from '../../../src/modules/@shared/domain/outbox/outbox-message.entity';
import {
  TransactionContext,
  type TransactionManager,
} from '../../../src/modules/@shared/domain/transaction/transaction-manager';
import { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction.entity';
import type { PendingReferenceMonitor } from '../../../src/modules/wagering/gateway/pending-reference-monitor.gateway';
import type { WagerTransactionGateway } from '../../../src/modules/wagering/gateway/wager-transaction.gateway';
import type { WalletMovementGateway } from '../../../src/modules/wagering/gateway/wallet-movement.gateway';
import { ResolvePendingWagerTransactionsUseCase } from '../../../src/modules/wagering/usecase/resolve-pending/resolve-pending.usecase';
import { WagerTransactionSettlement } from '../../../src/modules/wagering/usecase/wager-transaction-settlement';

class FakeContext extends TransactionContext {
  constructor() {
    super();
  }
}

const at = new Date('2026-10-25T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('ResolvePendingWagerTransactionsUseCase', () => {
  let transaction: WagerTransaction;
  let reference: WagerTransaction | null;
  let now: Date;
  let processingError: Error | undefined;
  let resolvedElsewhere: boolean;
  let returnedTerminal: boolean;
  let moves: number;
  let retries: number;
  let gauge: number;
  let outcomes: string[];
  let errors: unknown[];
  let trace: string[];
  let events: OutboxMessage[];
  let resolver: ResolvePendingWagerTransactionsUseCase;

  beforeEach(() => {
    now = new Date(at.getTime() + 1000);
    processingError = undefined;
    resolvedElsewhere = false;
    returnedTerminal = false;
    moves = retries = gauge = 0;
    outcomes = [];
    errors = [];
    trace = [];
    events = [];
    transaction = WagerTransaction.create({
      id: 'refund',
      providerId: 'provider',
      externalTransactionId: 'refund-ext',
      idempotencyKey: 'refund-key',
      walletId: 'wallet',
      playerId: 'player',
      roundId: 'round',
      gameId: 'game',
      kind: 'REFUND',
      money: brl('25.00'),
      at,
      referenceExternalTransactionId: 'bet-ext',
      correlationId: 'original',
    });
    transaction.markPendingReference(at, 3600);
    reference = null;
    const transactions: TransactionManager = {
      execute: (work) => work(new FakeContext()),
      snapshot: (work) => work(new FakeContext()),
    };
    const wagers: WagerTransactionGateway = {
      create: async () => undefined,
      update: async () => undefined,
      findById: async () => transaction,
      findByIdempotencyKey: async () => null,
      findByExternalId: async () => reference,
      findDueReferences: async () => [transaction],
      lockPendingReference: async () => {
        trace.push('transaction');
        if (resolvedElsewhere || returnedTerminal) {
          transaction.markProcessed(brl('100.00'), now, 'bet');
        }
        return resolvedElsewhere ? null : transaction;
      },
      findReversals: async () => [],
      accelerateReferences: async () => undefined,
      countPending: async () =>
        transaction.status === 'PENDING_REFERENCE' ? 1 : 0,
    };
    const wallets: WalletMovementGateway = {
      lock: async () => {
        trace.push('wallet');
        return {
          id: 'wallet',
          playerId: 'player',
          currency: 'BRL',
          balance: brl('75.00'),
          apply: async (movement) => {
            if (processingError) {
              throw processingError;
            }
            moves++;
            return {
              balance:
                movement.direction === 'CREDIT'
                  ? brl('75.00').add(movement.money)
                  : brl('75.00').subtract(movement.money),
              recordBalanceChanged: async () => undefined,
            };
          },
        };
      },
    };
    const monitor: PendingReferenceMonitor = {
      pending: (count) => {
        gauge = count;
      },
      resolved: (_tx, outcome) => {
        outcomes.push(outcome);
      },
      retryScheduled: () => {
        retries++;
      },
      failed: (_candidate, error) => {
        errors.push(error);
      },
    };
    const clock = { now: () => now };
    const settlement = new WagerTransactionSettlement(
      wagers,
      { next: () => Bun.randomUUIDv7() },
      clock,
      {
        create: async (event) => {
          events.push(event);
        },
      },
      3600,
    );
    resolver = new ResolvePendingWagerTransactionsUseCase(
      transactions,
      wagers,
      wallets,
      settlement,
      clock,
      monitor,
    );
  });

  const bet = () => {
    const tx = WagerTransaction.create({
      referenceExternalTransactionId: undefined,
      correlationId: 'correlation',
      id: 'bet',
      providerId: 'provider',
      externalTransactionId: 'bet-ext',
      idempotencyKey: 'bet-key',
      walletId: 'wallet',
      playerId: 'player',
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: brl('25.00'),
      at,
    });
    tx.markProcessed(brl('75.00'), at);
    return tx;
  };

  it('referência ausente agenda retry sem evento ou rejeição', async () => {
    expect(await resolver.execute({ limit: 10 })).toEqual({ attempted: 1 });
    expect(transaction.status).toBe('PENDING_REFERENCE');
    expect(transaction.referenceAttempts).toBe(1);
    expect(events).toHaveLength(0);
    expect(retries).toBe(1);
    expect(gauge).toBe(1);
  });

  it('referência resolvida aplica pelo colaborador e usa a correlação original', async () => {
    reference = bet();
    expect(await resolver.execute({ limit: 10 })).toEqual({ attempted: 1 });
    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.referenceTransactionId).toBe('bet');
    expect(transaction.resultBalance?.toString()).toBe('100.00');
    expect(events[0].payload.correlationId).toBe('original');
    expect(outcomes).toEqual(['processed']);
    expect(moves).toBe(1);
    expect(gauge).toBe(0);
  });

  it('TTL expirado com referência ausente rejeita e grava evento', async () => {
    now = new Date(at.getTime() + 3600000);
    await resolver.execute({ limit: 10 });
    expect(transaction.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
    expect(events[0].eventType).toBe('WagerTransactionRejected');
    expect(outcomes).toEqual(['expired']);
    expect(moves).toBe(0);
  });

  it('referência rejeitada gera o desfecho de negócio', async () => {
    reference = WagerTransaction.create({
      referenceExternalTransactionId: undefined,
      correlationId: 'correlation',
      id: 'bet',
      providerId: 'provider',
      externalTransactionId: 'bet-ext',
      idempotencyKey: 'bet-key',
      walletId: 'wallet',
      playerId: 'player',
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: brl('25.00'),
      at,
    });
    reference.reject(FailureCode.INSUFFICIENT_BALANCE, brl('0.00'), at);
    await resolver.execute({ limit: 10 });
    expect(transaction.failureCode).toBe(FailureCode.REFERENCE_NOT_PROCESSED);
    expect(outcomes).toEqual(['rejected']);
  });

  it('erro inesperado vira FAILED auditável, não REFERENCE_NOT_FOUND nem retry sem fim', async () => {
    reference = bet();
    now = new Date(at.getTime() + 3600000);
    processingError = new Error('falha inesperada');
    await resolver.execute({ limit: 10 });
    expect(transaction.status).toBe('FAILED');
    expect(transaction.failureCode).toBe(FailureCode.PROCESSING_FAILED);
    expect(transaction.processedAt).toEqual(now);
    expect(events).toHaveLength(0);
    expect(moves).toBe(0);
    expect(outcomes).toEqual(['failed']);
    expect(errors).toEqual([processingError]);
    expect(retries).toBe(0);
  });

  it('falha transitória mantém a pendência e agenda retry', async () => {
    reference = bet();
    processingError = new InfrastructureUnavailableError('PostgreSQL');
    await resolver.execute({ limit: 10 });
    expect(transaction.status).toBe('PENDING_REFERENCE');
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.referenceAttempts).toBe(1);
    expect(outcomes).toHaveLength(0);
    expect(retries).toBe(1);
  });

  it('referência existente pode ser processada depois do TTL', async () => {
    reference = bet();
    now = new Date(at.getTime() + 3600000);
    await resolver.execute({ limit: 10 });
    expect(transaction.status).toBe('PROCESSED');
    expect(outcomes).toEqual(['processed']);
  });

  it('corrida em que outro worker resolveu antes do lock sai sem efeito', async () => {
    resolvedElsewhere = true;
    expect(await resolver.execute({ limit: 10 })).toEqual({ attempted: 0 });
    expect(events).toHaveLength(0);
    expect(moves).toBe(0);
    expect(outcomes).toHaveLength(0);
  });

  it('gateway que devolve terminal também é protegido pela guarda de domínio', async () => {
    returnedTerminal = true;
    expect(await resolver.execute({ limit: 10 })).toEqual({ attempted: 0 });
    expect(events).toHaveLength(0);
    expect(moves).toBe(0);
  });

  it('trava wallet antes da linha pendente', async () => {
    await resolver.execute({ limit: 10 });
    expect(trace).toEqual(['wallet', 'transaction']);
  });
});
