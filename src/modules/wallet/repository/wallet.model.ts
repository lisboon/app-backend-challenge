import { defineEntity, p } from '@mikro-orm/postgresql';

export const WalletModel = defineEntity({
  name: 'WalletModel',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().length(3),
    balance: p.decimal('string').precision(20).scale(2),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
