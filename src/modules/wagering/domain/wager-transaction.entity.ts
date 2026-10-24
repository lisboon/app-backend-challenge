import { FailureCode } from '../../@shared/domain/failure-code';
import type { Money } from '../../@shared/domain/money';
import { payloadHash } from '../../@shared/domain/payload-hash';
import {
  InvalidTransactionStateError,
  TransactionAmountInvalidError,
  TransactionKindNotSubmittableError,
} from './errors/wagering.errors';

export const WagerTransactionKind = {
  Opening: 'OPENING',
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
} as const;

export type WagerTransactionKind =
  (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

export const WagerTransactionStatus = {
  Pending: 'PENDING',
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
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
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
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new TransactionKindNotSubmittableError();
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new TransactionAmountInvalidError();
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
    return this._status !== WagerTransactionStatus.Pending;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  ledgerDirectionFor(): MovementDirection {
    return this.kind === WagerTransactionKind.Bet
      ? MovementDirection.Debit
      : MovementDirection.Credit;
  }

  rejectionFor(wallet: TargetWallet): FailureCode | undefined {
    if (this.playerId !== wallet.playerId) {
      return FailureCode.WALLET_PLAYER_MISMATCH;
    }
    if (this.money.currency !== wallet.currency) {
      return FailureCode.CURRENCY_MISMATCH;
    }
    if (
      this.kind === WagerTransactionKind.Bet &&
      wallet.balance.isLessThan(this.money)
    ) {
      return FailureCode.INSUFFICIENT_BALANCE;
    }
    return undefined;
  }

  markProcessed(resultBalance: Money, at: Date): void {
    this.settle(WagerTransactionStatus.Processed, undefined, resultBalance, at);
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
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status);
    }
    this._status = status;
    this._failureCode = code;
    this._resultBalance = resultBalance;
    this._processedAt = at;
  }
}
