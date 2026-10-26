import { exponentialBackoff } from '../../@shared/domain/backoff';
import { FailureCode } from '../../@shared/domain/failure-code';
import type { Money } from '../../@shared/domain/money';
import { payloadHash } from '../../@shared/domain/payload-hash';
import {
  InvalidTransactionStateError,
  ProviderReservedError,
  ReferenceNotAllowedError,
  ReferenceRequiredError,
  ReferenceSelfError,
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
  Failed: 'FAILED',
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

const TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
> = {
  PENDING: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ],
  PENDING_REFERENCE: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

const ROLLBACK_TARGETS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
];

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
  referenceExternalTransactionId: string | undefined;
  correlationId: string;
}

interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
  correlationId: string;
}

export interface WagerTransactionState {
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
  referenceExternalTransactionId: string | undefined;
  correlationId: string;
  referenceTransactionId: string | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

export class WagerTransaction {
  readonly id: string;

  readonly providerId: string;

  readonly externalTransactionId: string;

  readonly idempotencyKey: string;

  readonly payloadHash: string;

  readonly walletId: string;

  readonly playerId: string;

  readonly roundId: string | undefined;

  readonly gameId: string | undefined;

  readonly kind: WagerTransactionKind;

  readonly money: Money;

  readonly createdAt: Date;

  readonly referenceExternalTransactionId: string | undefined;

  readonly correlationId: string;

  private _status: WagerTransactionStatus;

  private _failureCode: FailureCode | undefined;

  private _resultBalance: Money | undefined;

  private _processedAt: Date | undefined;

  private _referenceTransactionId: string | undefined;

  private _referenceAttempts: number;

  private _nextReferenceAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.createdAt = state.createdAt;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.correlationId = state.correlationId;
    this._status = state.status;
    this._failureCode = state.failureCode;
    this._resultBalance = state.resultBalance;
    this._processedAt = state.processedAt;
    this._referenceTransactionId = state.referenceTransactionId;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
  }

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
    WagerTransaction.assertReference(props);
    const money = props.money.toJSON();
    return new WagerTransaction({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: payloadHash({
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
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      createdAt: props.at,
      status: WagerTransactionStatus.Pending,
      failureCode: undefined,
      resultBalance: undefined,
      processedAt: undefined,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      correlationId: props.correlationId,
      referenceTransactionId: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
  }

  static opening(props: OpeningTransactionProps): WagerTransaction {
    const externalTransactionId = `opening:${props.walletId}`;
    const money = props.money.toJSON();
    return new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`,
      payloadHash: payloadHash({
        kind: WagerTransactionKind.Opening,
        walletId: props.walletId,
        playerId: props.playerId,
        money: { amount: money.amount, currency: money.currency },
      }),
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: undefined,
      gameId: undefined,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      failureCode: undefined,
      resultBalance: props.money,
      processedAt: props.at,
      referenceExternalTransactionId: undefined,
      correlationId: props.correlationId,
      referenceTransactionId: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  private static assertReference(props: CreateWagerTransactionProps): void {
    const reference = props.referenceExternalTransactionId;
    if (kindRequiresReference(props.kind) && reference === undefined) {
      throw new ReferenceRequiredError();
    }
    if (
      (props.kind === WagerTransactionKind.Bet ||
        props.kind === WagerTransactionKind.Loss) &&
      reference !== undefined
    ) {
      throw new ReferenceNotAllowedError();
    }
    if (reference === props.externalTransactionId) {
      throw new ReferenceSelfError();
    }
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

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return kindRequiresReference(this.kind);
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  awaitsReference(reference: WagerTransaction | null): boolean {
    return (
      this.hasReference() &&
      reference?.status !== WagerTransactionStatus.Processed
    );
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
    reference: WagerTransaction | null,
    reversals: readonly WagerTransaction[],
  ): FailureCode | undefined {
    return (
      this.walletRejection(wallet) ??
      this.referenceRejection(reference, reversals) ??
      (this.awaitsReference(reference)
        ? undefined
        : this.balanceRejection(wallet, reference ?? undefined))
    );
  }

  markPendingReference(now: Date, ttlSeconds: number): void {
    assertWagerTransactionTransition(
      this._status,
      WagerTransactionStatus.PendingReference,
    );
    if (!this.hasReference()) {
      throw new Error('transação sem referência não pode aguardá-la');
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = this.referenceAttemptAt(now, 1, ttlSeconds);
  }

  scheduleReferenceRetry(now: Date, ttlSeconds?: number): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status);
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = this.referenceAttemptAt(
      now,
      this._referenceAttempts,
      ttlSeconds,
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
    return now.getTime() >= this.referenceDeadline(ttlSeconds);
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
    if (this.hasReference() && !referenceTransactionId) {
      throw new Error('desfecho processado exige referência resolvida');
    }
    this.settle(WagerTransactionStatus.Processed, undefined, resultBalance, at);
    this._referenceTransactionId = referenceTransactionId;
  }

  reject(code: FailureCode, resultBalance: Money, at: Date): void {
    this.settle(WagerTransactionStatus.Rejected, code, resultBalance, at);
  }

  fail(code: FailureCode, at: Date): void {
    this.settle(WagerTransactionStatus.Failed, code, undefined, at);
  }

  private walletRejection(wallet: TargetWallet): FailureCode | undefined {
    if (this.playerId !== wallet.playerId) {
      return FailureCode.WALLET_PLAYER_MISMATCH;
    }
    if (this.money.currency !== wallet.currency) {
      return FailureCode.CURRENCY_MISMATCH;
    }
    return undefined;
  }

  private referenceRejection(
    reference: WagerTransaction | null,
    reversals: readonly WagerTransaction[],
  ): FailureCode | undefined {
    if (!this.hasReference() || !reference) {
      return undefined;
    }
    if (!this.acceptsReferenceKind(reference.kind)) {
      return FailureCode.REFERENCE_KIND_INVALID;
    }
    if (!this.sharesIdentityWith(reference)) {
      return FailureCode.REFERENCE_MISMATCH;
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reference.isTerminal()
        ? FailureCode.REFERENCE_NOT_PROCESSED
        : undefined;
    }
    return (
      this.reversalRejection(reference, reversals) ??
      this.amountRejection(reference)
    );
  }

  private acceptsReferenceKind(kind: WagerTransactionKind): boolean {
    return this.kind === WagerTransactionKind.Rollback
      ? ROLLBACK_TARGETS.includes(kind)
      : kind === WagerTransactionKind.Bet;
  }

  private sharesIdentityWith(reference: WagerTransaction): boolean {
    return (
      reference.walletId === this.walletId &&
      reference.playerId === this.playerId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId
    );
  }

  private reversalRejection(
    reference: WagerTransaction,
    reversals: readonly WagerTransaction[],
  ): FailureCode | undefined {
    const applied = reversals.filter(
      (reversal) => reversal.status === WagerTransactionStatus.Processed,
    );
    const alreadyBySameKind =
      this.requiresReference() &&
      applied.some(
        (reversal) =>
          reversal.kind === this.kind &&
          reversal.referenceTransactionId === reference.id,
      );
    const betNoLongerStands =
      reference.kind === WagerTransactionKind.Bet &&
      isNetReversed(reference, applied);
    return alreadyBySameKind || betNoLongerStands
      ? FailureCode.REFERENCE_ALREADY_REVERSED
      : undefined;
  }

  private amountRejection(
    reference: WagerTransaction,
  ): FailureCode | undefined {
    return this.requiresReference() && !this.money.equals(reference.money)
      ? FailureCode.REVERSAL_AMOUNT_MISMATCH
      : undefined;
  }

  private balanceRejection(
    wallet: TargetWallet,
    reference: WagerTransaction | undefined,
  ): FailureCode | undefined {
    if (!this.affectsBalance()) {
      return undefined;
    }
    if (this.ledgerDirectionFor(reference) === MovementDirection.Credit) {
      return wallet.balance.canAdd(this.money)
        ? undefined
        : FailureCode.BALANCE_LIMIT_EXCEEDED;
    }
    if (!wallet.balance.isLessThan(this.money)) {
      return undefined;
    }
    return this.kind === WagerTransactionKind.Rollback
      ? FailureCode.REVERSAL_INSUFFICIENT_BALANCE
      : FailureCode.INSUFFICIENT_BALANCE;
  }

  private referenceDeadline(ttlSeconds: number): number {
    return this.createdAt.getTime() + ttlSeconds * 1000;
  }

  private referenceAttemptAt(
    now: Date,
    attempts: number,
    ttlSeconds?: number,
  ): Date {
    const next = now.getTime() + exponentialBackoff(attempts);
    return new Date(
      ttlSeconds === undefined
        ? next
        : Math.min(next, this.referenceDeadline(ttlSeconds)),
    );
  }

  private settle(
    status: WagerTransactionStatus,
    code: FailureCode | undefined,
    resultBalance: Money | undefined,
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

function kindRequiresReference(kind: WagerTransactionKind): boolean {
  return (
    kind === WagerTransactionKind.Refund ||
    kind === WagerTransactionKind.Rollback
  );
}

function isNetReversed(
  bet: WagerTransaction,
  applied: readonly WagerTransaction[],
): boolean {
  const undone = (refund: WagerTransaction): boolean =>
    applied.some(
      (undo) =>
        undo.kind === WagerTransactionKind.Rollback &&
        undo.referenceTransactionId === refund.id,
    );
  return applied.some(
    (reversal) =>
      reversal.referenceTransactionId === bet.id &&
      (reversal.kind === WagerTransactionKind.Rollback ||
        (reversal.kind === WagerTransactionKind.Refund && !undone(reversal))),
  );
}

export function assertWagerTransactionTransition(
  from: WagerTransactionStatus,
  to: WagerTransactionStatus,
): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidTransactionStateError(from);
  }
}
