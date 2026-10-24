import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000002WagerSubmit extends Migration {
  override up(): void {
    this.addSql(
      'alter table wager_transactions drop constraint wager_tx_wallet_fk',
    );
    this.addSql('alter table wallets drop constraint wallets_identity_uk');
    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_wallet_fk foreign key (wallet_id) references wallets (id)
    `);

    this.addSql(`
      alter table wager_transactions
        add column result_balance numeric(20, 2),
        add column result_currency char(3)
    `);
    this.addSql(`
      update wager_transactions t
         set result_currency = (select currency from wallets where id = t.wallet_id),
             result_balance = coalesce(
           (select l.balance_after
              from wallet_ledger_entries l
             where l.transaction_id = t.id),
           (select l.balance_after
              from wallet_ledger_entries l
             where l.wallet_id = t.wallet_id and l.created_at <= t.created_at
             order by l.wallet_version desc
             limit 1),
           0)
       where t.status in ('PROCESSED', 'REJECTED')
    `);
    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_result_balance_ck
          check ((status in ('PROCESSED', 'REJECTED')) = (result_balance is not null)),
        add constraint wager_tx_result_currency_ck
          check ((result_balance is null) = (result_currency is null)),
        add constraint wager_tx_result_balance_non_negative_ck
          check (result_balance >= 0),
        add constraint wager_tx_positive_amount_ck
          check (kind = 'LOSS' or amount > 0)
    `);

    this.addSql(`
      alter table wallet_ledger_entries
        alter constraint ledger_transaction_fk deferrable initially deferred
    `);

    this.addSql(`
      create function wallet_ledger_entries_check_transaction() returns trigger
      language plpgsql as $$
      declare
        tx_kind text;
        tx_status text;
        tx_amount numeric(20, 2);
        tx_currency char(3);
        tx_player uuid;
        wallet_currency char(3);
        wallet_player uuid;
      begin
        select kind, status, amount, currency, player_id
          into tx_kind, tx_status, tx_amount, tx_currency, tx_player
          from wager_transactions where id = new.transaction_id;
        if not found then
          return null;
        end if;
        select currency, player_id into wallet_currency, wallet_player
          from wallets where id = new.wallet_id;
        if tx_status <> 'PROCESSED' or tx_kind = 'LOSS' then
          raise exception 'lançamento % exige transação PROCESSED que move saldo', new.id
            using errcode = '23514';
        end if;
        if tx_amount <> new.amount
          or tx_currency <> wallet_currency
          or tx_player <> wallet_player then
          raise exception 'lançamento % diverge do valor, da moeda ou do player da transação', new.id
            using errcode = '23514';
        end if;
        if (tx_kind = 'BET' and new.direction <> 'DEBIT')
          or (tx_kind in ('OPENING', 'WIN', 'REFUND') and new.direction <> 'CREDIT') then
          raise exception 'lançamento % tem direção incompatível com %', new.id, tx_kind
            using errcode = '23514';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_match_transaction
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_check_transaction()
    `);

    this.addSql(`
      create function wager_transactions_check_ledger() returns trigger
      language plpgsql as $$
      begin
        if new.status = 'PROCESSED' and new.kind <> 'LOSS'
          and not exists (
            select 1 from wallet_ledger_entries where transaction_id = new.id
          ) then
          raise exception 'transação % aplicada sem lançamento no ledger', new.id
            using errcode = '23514';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger wager_transactions_require_ledger
        after insert or update on wager_transactions
        deferrable initially deferred
        for each row execute function wager_transactions_check_ledger()
    `);
  }

  override down(): void {
    this.addSql(
      'drop trigger wager_transactions_require_ledger on wager_transactions',
    );
    this.addSql('drop function wager_transactions_check_ledger()');
    this.addSql(
      'drop trigger wallet_ledger_entries_match_transaction on wallet_ledger_entries',
    );
    this.addSql('drop function wallet_ledger_entries_check_transaction()');
    this.addSql(`
      alter table wallet_ledger_entries
        alter constraint ledger_transaction_fk not deferrable
    `);
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_tx_positive_amount_ck,
        drop constraint wager_tx_result_balance_non_negative_ck,
        drop constraint wager_tx_result_currency_ck,
        drop constraint wager_tx_result_balance_ck,
        drop column result_currency,
        drop column result_balance
    `);
    this.addSql(
      'alter table wager_transactions drop constraint wager_tx_wallet_fk',
    );
    this.addSql(`
      alter table wallets
        add constraint wallets_identity_uk unique (id, player_id, currency)
    `);
    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_wallet_fk foreign key (wallet_id, player_id, currency)
          references wallets (id, player_id, currency) not valid
    `);
  }
}
