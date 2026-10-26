import { defineEntity, p } from '@mikro-orm/postgresql';

export const LedgerEntryModel = defineEntity({
  name: 'LedgerEntryModel',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.string(),
    amount: p.decimal('string').precision(20).scale(2),
    balanceBefore: p.decimal('string').precision(20).scale(2),
    balanceAfter: p.decimal('string').precision(20).scale(2),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});
