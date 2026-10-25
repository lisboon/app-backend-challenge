import { exponentialBackoff } from '../../@shared/domain/backoff';
import { MoneyOverflowError } from '../../@shared/domain/errors/money.errors';
import { FailureCode } from '../../@shared/domain/failure-code';
import type { Money } from '../../@shared/domain/money';
import { payloadHash } from '../../@shared/domain/payload-hash';
import {
  InvalidTransactionStateError,
  ProviderReservedError,
  ReferenceNotAllowedError,
  ReferenceRequiredError,
  TransactionAmountInvalidError,
  TransactionKindNotSubmittableError,
} from './errors/wagering.errors';

export const WagerTransactionKind = {
  Opening: 'OPENING',
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;

export type WagerTransactionKind =
  (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

export const WagerTransactionStatus = {
  Pending: 'PENDING',
  PendingReference: 'PENDING_REFERENCE',
  Processed: 'PROCESSED',
  Rejected: 'REJECTED',
} as const;

export type WagerTransactionStatus =
  (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

export const MovementDirection = {
  Debit: 'DEBIT',
  Credit: 'CREDIT',
} as const;

export type MovementDirection =
  (typeof MovementDirection)[keyof typeof MovementDirection];

export const INTERNAL_PROVIDER_ID = 'internal';

export interface TargetWallet {
  playerId: string;
  currency: string;
  balance: Money;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  at: Date;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export interface WagerTransactionState {
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  correlationId?: string;
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date;
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  createdAt: Date;
  status: WagerTransactionStatus;
  failureCode: FailureCode | undefined;
  resultBalance: Money | undefined;
  processedAt: Date | undefined;
}

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string | undefined,
    readonly gameId: string | undefined,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _failureCode: FailureCode | undefined,
    private _resultBalance: Money | undefined,
    private _processedAt: Date | undefined,
    readonly referenceExternalTransactionId?: string,
    readonly correlationId: string = id,
    private _referenceTransactionId?: string,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new TransactionKindNotSubmittableError();
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new ProviderReservedError();
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new TransactionAmountInvalidError();
    }
    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw new ReferenceRequiredError();
    }
    if (
      (props.kind === WagerTransactionKind.Bet ||
        props.kind === WagerTransactionKind.Loss) &&
      props.referenceExternalTransactionId !== undefined
    ) {
      throw new ReferenceNotAllowedError();
    }
    const money = props.money.toJSON();
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      payloadHash({
        providerId: props.providerId,
        externalTransactionId: props.externalTransactionId,
        walletId: props.walletId,
        playerId: props.playerId,
        roundId: props.roundId,
        gameId: props.gameId,
        kind: props.kind,
        referenceExternalTransactionId: props.referenceExternalTransactionId,
        money: { amount: money.amount, currency: money.currency },
      }),
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.at,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      props.referenceExternalTransactionId,
      props.correlationId,
    );
  }

  static opening(props: OpeningTransactionProps): WagerTransaction {
    const externalTransactionId = `opening:${props.walletId}`;
    const money = props.money.toJSON();
    return new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      externalTransactionId,
      `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`,
      payloadHash({
        kind: WagerTransactionKind.Opening,
        walletId: props.walletId,
        playerId: props.playerId,
        money: { amount: money.amount, currency: money.currency },
      }),
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      props.at,
      WagerTransactionStatus.Processed,
      undefined,
      props.money,
      props.at,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.createdAt,
      state.status,
      state.failureCode,
      state.resultBalance,
      state.processedAt,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.referenceTransactionId,
      state.referenceAttempts ?? 0,
      state.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.referenceExternalTransactionId !== undefined ||
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  ledgerDirectionFor(reference?: WagerTransaction): MovementDirection {
    if (this.kind === WagerTransactionKind.Rollback) {
      if (!reference) {
        throw new Error(
          'ROLLBACK exige referência resolvida para determinar a direção',
        );
      }
      return reference.kind === WagerTransactionKind.Bet
        ? MovementDirection.Credit
        : MovementDirection.Debit;
    }
    return this.kind === WagerTransactionKind.Bet
      ? MovementDirection.Debit
      : MovementDirection.Credit;
  }

  rejectionFor(
    wallet: TargetWallet,
    reference?: WagerTransaction | null,
    reversals: readonly WagerTransaction[] = [],
  ): FailureCode | undefined {
    if (this.playerId !== wallet.playerId) {
      return FailureCode.WALLET_PLAYER_MISMATCH;
    }
    if (this.money.currency !== wallet.currency) {
      return FailureCode.CURRENCY_MISMATCH;
    }
    if (this.requiresReference()) {
      if (!reference) {
        return undefined;
      }
      const compatible =
        this.kind === WagerTransactionKind.Rollback
          ? [
              WagerTransactionKind.Bet,
              WagerTransactionKind.Win,
              WagerTransactionKind.Refund,
            ].some((kind) => kind === reference.kind)
          : reference.kind === WagerTransactionKind.Bet;
      if (!compatible) {
        return FailureCode.REFERENCE_KIND_INVALID;
      }
      if (
        reference.providerId !== this.providerId ||
        reference.externalTransactionId !==
          this.referenceExternalTransactionId ||
        reference.walletId !== this.walletId ||
        reference.playerId !== this.playerId ||
        reference.money.currency !== this.money.currency ||
        reference.roundId !== this.roundId
      ) {
        return FailureCode.REFERENCE_MISMATCH;
      }
      if (reference.status === WagerTransactionStatus.Rejected) {
        return FailureCode.REFERENCE_NOT_PROCESSED;
      }
      if (reference.status !== WagerTransactionStatus.Processed) {
        return undefined;
      }
      if (this.kind !== WagerTransactionKind.Win) {
        const processed = reversals.filter(
          (t) => t.status === WagerTransactionStatus.Processed,
        );
        const direct = processed.filter(
          (t) => t.referenceTransactionId === reference.id,
        );
        if (direct.some((t) => t.kind === this.kind)) {
          return FailureCode.REFERENCE_ALREADY_REVERSED;
        }
        if (reference.kind === WagerTransactionKind.Bet) {
          const rollback = direct.some(
            (t) => t.kind === WagerTransactionKind.Rollback,
          );
          const liveRefund = direct.some(
            (t) =>
              t.kind === WagerTransactionKind.Refund &&
              !processed.some(
                (child) =>
                  child.kind === WagerTransactionKind.Rollback &&
                  child.referenceTransactionId === t.id,
              ),
          );
          if (
            (this.kind === WagerTransactionKind.Refund && rollback) ||
            (this.kind === WagerTransactionKind.Rollback && liveRefund)
          ) {
            return FailureCode.REFERENCE_ALREADY_REVERSED;
          }
        }
        if (!this.money.equals(reference.money)) {
          return FailureCode.REVERSAL_AMOUNT_MISMATCH;
        }
      }
    }
    const direction = this.ledgerDirectionFor(reference ?? undefined);
    if (
      this.affectsBalance() &&
      direction === MovementDirection.Debit &&
      wallet.balance.isLessThan(this.money)
    ) {
      return this.kind === WagerTransactionKind.Rollback
        ? FailureCode.REVERSAL_INSUFFICIENT_BALANCE
        : FailureCode.INSUFFICIENT_BALANCE;
    }
    if (this.affectsBalance() && direction === MovementDirection.Credit) {
      try {
        wallet.balance.add(this.money);
      } catch (error) {
        if (error instanceof MoneyOverflowError) {
          return FailureCode.BALANCE_LIMIT_EXCEEDED;
        }
        throw error;
      }
    }
    return undefined;
  }

  markPendingReference(now: Date): void {
    assertWagerTransactionTransition(
      this._status,
      WagerTransactionStatus.PendingReference,
    );
    if (!this.requiresReference()) {
      throw new Error('transação sem referência não pode aguardá-la');
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = new Date(
      now.getTime() + exponentialBackoff(1),
    );
  }

  scheduleReferenceRetry(now: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status);
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = new Date(
      now.getTime() + exponentialBackoff(this._referenceAttempts),
    );
  }

  isReferenceDue(now: Date): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._nextReferenceAttemptAt !== undefined &&
      this._nextReferenceAttemptAt <= now
    );
  }

  referenceExpired(now: Date, ttlSeconds: number): boolean {
    return now.getTime() >= this.createdAt.getTime() + ttlSeconds * 1000;
  }

  markProcessed(
    resultBalance: Money,
    at: Date,
    referenceTransactionId?: string,
  ): void {
    assertWagerTransactionTransition(
      this._status,
      WagerTransactionStatus.Processed,
    );
    if (this.requiresReference() && !referenceTransactionId) {
      throw new Error('desfecho processado exige referência resolvida');
    }
    this.settle(WagerTransactionStatus.Processed, undefined, resultBalance, at);
    this._referenceTransactionId = referenceTransactionId;
  }

  reject(code: FailureCode, resultBalance: Money, at: Date): void {
    this.settle(WagerTransactionStatus.Rejected, code, resultBalance, at);
  }

  private settle(
    status: WagerTransactionStatus,
    code: FailureCode | undefined,
    resultBalance: Money,
    at: Date,
  ): void {
    assertWagerTransactionTransition(this._status, status);
    this._status = status;
    this._failureCode = code;
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }
}

export function assertWagerTransactionTransition(
  from: WagerTransactionStatus,
  to: WagerTransactionStatus,
): void {
  const allowed: Readonly<
    Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
  > = {
    PENDING: [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.PendingReference,
    ],
    PENDING_REFERENCE: [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ],
    PROCESSED: [],
    REJECTED: [],
  };
  if (!allowed[from].includes(to)) {
    throw new InvalidTransactionStateError(from);
  }
}
