import { Migration20261024000001Wallets } from './Migration20261024000001Wallets';
import { Migration20261024000002WagerSubmit } from './Migration20261024000002WagerSubmit';

export const MIGRATIONS = [
  {
    name: 'Migration20261024000001Wallets',
    class: Migration20261024000001Wallets,
  },
  {
    name: 'Migration20261024000002WagerSubmit',
    class: Migration20261024000002WagerSubmit,
  },
];
