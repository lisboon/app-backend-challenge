import type { Money } from '../../@shared/domain/money';

export class WalletReconciliation {
  private constructor(
    readonly walletId: string,
    readonly storedBalance: Money,
    readonly calculatedBalance: Money,
    readonly difference: Money,
    readonly consistent: boolean,
    readonly checkedEntries: number,
  ) {}

  static compare(input: {
    walletId: string;
    stored: Money;
    calculated: Money;
    checkedEntries: number;
  }): WalletReconciliation {
    const difference = input.stored.subtract(input.calculated);
    return new WalletReconciliation(
      input.walletId,
      input.stored,
      input.calculated,
      difference,
      difference.isZero(),
      input.checkedEntries,
    );
  }
}
