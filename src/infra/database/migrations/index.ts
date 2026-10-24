import { Migration20261024000001Wallets } from './Migration20261024000001Wallets';
import { Migration20261024000002WagerSubmit } from './Migration20261024000002WagerSubmit';
import { Migration20261024000003Outbox } from './Migration20261024000003Outbox';
import { Migration20261024000004OutboxOrdering } from './Migration20261024000004OutboxOrdering';

export const MIGRATIONS = [
  {
    name: 'Migration20261024000001Wallets',
    class: Migration20261024000001Wallets,
  },
  {
    name: 'Migration20261024000002WagerSubmit',
    class: Migration20261024000002WagerSubmit,
  },
  {
    name: 'Migration20261024000003Outbox',
    class: Migration20261024000003Outbox,
  },
  {
    name: 'Migration20261024000004OutboxOrdering',
    class: Migration20261024000004OutboxOrdering,
  },
];
