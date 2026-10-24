import { Money } from '../../@shared/domain/money';
import { payloadHash } from '../../@shared/domain/payload-hash';

export const WagerTransactionKind = {
  Opening: 'OPENING',
} as const;

export type WagerTransactionKind =
  (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

export const WagerTransactionStatus = {
  Processed: 'PROCESSED',
} as const;

export type WagerTransactionStatus =
  (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

export const INTERNAL_PROVIDER_ID = 'internal';

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
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
    private _processedAt: Date | undefined,
  ) {}

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
      props.at,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }
}
