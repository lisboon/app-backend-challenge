import { Migration20261024000001Wallets } from './Migration20261024000001Wallets';
import { Migration20261024000002WagerSubmit } from './Migration20261024000002WagerSubmit';
import { Migration20261024000003Outbox } from './Migration20261024000003Outbox';
import { Migration20261024000004OutboxOrdering } from './Migration20261024000004OutboxOrdering';
import { Migration20261025000005WagerReversals } from './Migration20261025000005WagerReversals';
import { Migration20261025000006Inbox } from './Migration20261025000006Inbox';

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
  {
    name: 'Migration20261025000005WagerReversals',
    class: Migration20261025000005WagerReversals,
  },
  {
    name: 'Migration20261025000006Inbox',
    class: Migration20261025000006Inbox,
  },
];
