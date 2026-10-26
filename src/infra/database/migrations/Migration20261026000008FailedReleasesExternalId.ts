import { Migration } from '@mikro-orm/migrations';

export class Migration20261026000008FailedReleasesExternalId extends Migration {
  override up(): void {
    this.addSql(
      'alter table wager_transactions drop constraint wager_tx_external_uk',
    );
    this.addSql(
      "create unique index wager_tx_external_uk on wager_transactions(provider_id,external_transaction_id) where status<>'FAILED'",
    );
  }

  override down(): void {
    this.addSql(`do $$ begin
  if exists (select 1 from wager_transactions group by provider_id,external_transaction_id having count(*)>1) then
    raise exception 'há FAILED repetindo um id externo; voltar exigiria apagar auditoria' using errcode='23505',constraint='wager_tx_external_uk';
  end if;
end $$`);
    this.addSql('drop index wager_tx_external_uk');
    this.addSql(
      'alter table wager_transactions add constraint wager_tx_external_uk unique (provider_id,external_transaction_id)',
    );
  }
}
