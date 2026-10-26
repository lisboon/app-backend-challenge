import { Migration } from '@mikro-orm/migrations';

export class Migration20261026000009ExternalIdLookup extends Migration {
  override up(): void {
    this.addSql(
      'create index wager_tx_external_idx on wager_transactions(provider_id,external_transaction_id)',
    );
  }

  override down(): void {
    this.addSql('drop index wager_tx_external_idx');
  }
}
