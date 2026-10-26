import { Migration20261024000001Wallets } from './Migration20261024000001Wallets';
import { Migration20261024000002WagerSubmit } from './Migration20261024000002WagerSubmit';
import { Migration20261024000003Outbox } from './Migration20261024000003Outbox';
import { Migration20261024000004OutboxOrdering } from './Migration20261024000004OutboxOrdering';
import { Migration20261025000005WagerReversals } from './Migration20261025000005WagerReversals';
import { Migration20261025000006Inbox } from './Migration20261025000006Inbox';
import { Migration20261025000007FailedTransitions } from './Migration20261025000007FailedTransitions';
import { Migration20261026000008FailedReleasesExternalId } from './Migration20261026000008FailedReleasesExternalId';
import { Migration20261026000009ExternalIdLookup } from './Migration20261026000009ExternalIdLookup';

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
  {
    name: 'Migration20261025000007FailedTransitions',
    class: Migration20261025000007FailedTransitions,
  },
  {
    name: 'Migration20261026000008FailedReleasesExternalId',
    class: Migration20261026000008FailedReleasesExternalId,
  },
  {
    name: 'Migration20261026000009ExternalIdLookup',
    class: Migration20261026000009ExternalIdLookup,
  },
];
