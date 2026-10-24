import { describe, it, expect } from 'bun:test';

import { Money } from '../../../src/modules/@shared/domain/money';
import { WalletReconciliation } from '../../../src/modules/wallet/domain/wallet-reconciliation';

const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });
describe('WalletReconciliation', () => {
  it.each([
    ['10.00', '10.00', '0.00', true],
    ['11.00', '10.00', '1.00', false],
    ['9.00', '10.00', '-1.00', false],
  ])('compara %s e %s', (stored, calculated, difference, consistent) => {
    const report = WalletReconciliation.compare({
      walletId: 'wallet',
      stored: money(stored),
      calculated: money(calculated),
      checkedEntries: 3,
    });
    expect(report.difference.toString()).toBe(difference);
    expect(report.consistent).toBe(consistent);
    expect(report.checkedEntries).toBe(3);
  });

  it('recusa moedas diferentes', () => {
    expect(() =>
      WalletReconciliation.compare({
        walletId: 'wallet',
        stored: money('1.00'),
        calculated: money('1.00', 'USD'),
        checkedEntries: 1,
      }),
    ).toThrow();
  });
});
