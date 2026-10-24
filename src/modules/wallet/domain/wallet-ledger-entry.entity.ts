import { Money } from '../../@shared/domain/money';
import { WalletInvariantError } from './errors/wallet.errors';

export const LedgerDirection = {
  Debit: 'DEBIT',
  Credit: 'CREDIT',
} as const;

export type LedgerDirection =
  (typeof LedgerDirection)[keyof typeof LedgerDirection];

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt,
    );
    if (!props.money.isPositive()) {
      throw new WalletInvariantError('valor do lançamento deve ser positivo');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new WalletInvariantError('lançamento com saldo negativo');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new WalletInvariantError('versão da wallet deve ser inteiro >= 1');
    }
    if (!entry.isBalanced()) {
      throw new WalletInvariantError(
        'saldo anterior com o valor do lançamento difere do saldo posterior',
      );
    }
    return entry;
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
