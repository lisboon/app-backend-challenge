import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000001Wallets extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(20, 2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_uk unique (player_id, currency),
        constraint wallets_identity_uk unique (id, player_id, currency),
        constraint wallets_currency_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_ck check (balance >= 0),
        constraint wallets_version_ck check (version >= 1),
        constraint wallets_timestamps_ck check (updated_at >= created_at)
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id uuid not null,
        currency char(3) not null,
        round_id text,
        game_id text,
        kind text not null,
        amount numeric(20, 2) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text not null,
        failure_code text,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_tx_wallet_fk foreign key (wallet_id, player_id, currency)
          references wallets (id, player_id, currency),
        constraint wager_tx_reference_fk foreign key (reference_transaction_id)
          references wager_transactions (id),
        constraint wager_tx_idempotency_uk unique (provider_id, idempotency_key),
        constraint wager_tx_external_uk unique (provider_id, external_transaction_id),
        constraint wager_tx_wallet_uk unique (id, wallet_id),
        constraint wager_tx_kind_ck
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_tx_status_ck
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_tx_internal_ck
          check ((provider_id = 'internal') = (kind = 'OPENING')),
        constraint wager_tx_round_ck
          check (kind = 'OPENING' or (round_id is not null and game_id is not null)),
        constraint wager_tx_reference_required_ck
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_amount_ck check (amount >= 0),
        constraint wager_tx_payload_hash_ck check (payload_hash ~ '^v1:[0-9a-f]{64}$'),
        constraint wager_tx_failure_ck
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_tx_processed_at_ck
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null))
      )
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null,
        direction text not null,
        amount numeric(20, 2) not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        wallet_version integer not null,
        created_at timestamptz not null,
        constraint ledger_transaction_fk foreign key (transaction_id, wallet_id)
          references wager_transactions (id, wallet_id),
        constraint ledger_transaction_wallet_uk unique (transaction_id, wallet_id),
        constraint ledger_wallet_version_uk unique (wallet_id, wallet_version),
        constraint ledger_direction_ck check (direction in ('DEBIT', 'CREDIT')),
        constraint ledger_amount_ck check (amount > 0),
        constraint ledger_balances_ck check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_version_ck check (wallet_version >= 1),
        constraint ledger_arithmetic_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      )
    `);

    this.addSql(`
      create function wallet_ledger_entries_reject_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries é append-only' using errcode = 'P0001';
      end
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_reject_mutation()
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_reject_mutation()
    `);

    this.addSql(`
      create function wallet_ledger_entries_check_chain() returns trigger
      language plpgsql as $$
      declare
        previous numeric(20, 2);
      begin
        select balance_after into previous
          from wallet_ledger_entries
          where wallet_id = new.wallet_id and wallet_version < new.wallet_version
          order by wallet_version desc
          limit 1;
        if new.balance_before <> coalesce(previous, 0) then
          raise exception 'lançamento % não continua o saldo anterior da wallet %', new.id, new.wallet_id
            using errcode = '23514';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_chain
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_check_chain()
    `);

    this.addSql(`
      create function wallets_assert_matches_ledger(target uuid) returns void
      language plpgsql as $$
      declare
        current_balance numeric(20, 2);
        current_version integer;
        last_balance numeric(20, 2);
        last_version integer;
      begin
        select balance, version into current_balance, current_version
          from wallets where id = target;
        select balance_after, wallet_version into last_balance, last_version
          from wallet_ledger_entries
          where wallet_id = target
          order by wallet_version desc
          limit 1;
        if coalesce(last_balance, 0) <> current_balance
          or coalesce(last_version, 1) <> current_version then
          raise exception 'saldo da wallet % diverge do ledger', target
            using errcode = '23514';
        end if;
      end
      $$
    `);
    this.addSql(`
      create function wallets_check_ledger() returns trigger
      language plpgsql as $$
      begin
        perform wallets_assert_matches_ledger(new.id);
        return null;
      end
      $$
    `);
    this.addSql(`
      create function wallet_ledger_entries_check_wallet() returns trigger
      language plpgsql as $$
      begin
        perform wallets_assert_matches_ledger(new.wallet_id);
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger wallets_balance_matches_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_check_ledger()
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_match_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_check_wallet()
    `);
  }

  override down(): void {
    this.addSql('drop table wallet_ledger_entries');
    this.addSql('drop table wager_transactions');
    this.addSql('drop table wallets');
    this.addSql('drop function wallet_ledger_entries_check_wallet()');
    this.addSql('drop function wallets_check_ledger()');
    this.addSql('drop function wallets_assert_matches_ledger(uuid)');
    this.addSql('drop function wallet_ledger_entries_check_chain()');
    this.addSql('drop function wallet_ledger_entries_reject_mutation()');
  }
}
