import { Money } from '../../@shared/domain/money';
import { WalletInvariantError } from './errors/wallet.errors';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry.entity';

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry: WalletLedgerEntry | undefined;
}

const INITIAL_VERSION = 1;

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new WalletInvariantError('saldo inicial negativo');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      INITIAL_VERSION,
      props.at,
      props.at,
    );
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: wallet.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
          walletVersion: wallet.version,
          createdAt: props.at,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.balance.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  hasFunds(money: Money): boolean {
    return !this._balance.isLessThan(money);
  }

  debit(movement: WalletMovementProps): WalletLedgerEntry {
    if (!this.hasFunds(movement.money)) {
      throw new WalletInvariantError('débito maior que o saldo');
    }
    return this.move(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovementProps): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, movement);
  }

  private move(
    direction: LedgerDirection,
    movement: WalletMovementProps,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(movement.money)
        : balanceBefore.add(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }
}
