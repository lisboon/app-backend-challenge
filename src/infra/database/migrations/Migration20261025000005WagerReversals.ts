import { Migration } from '@mikro-orm/migrations';

export class Migration20261025000005WagerReversals extends Migration {
  override up(): void {
    this.addSql(`
alter table wager_transactions add column reference_attempts integer not null default 0,
  add column next_reference_attempt_at timestamptz, add column correlation_id text;
update wager_transactions set correlation_id=id::text,
  next_reference_attempt_at=case when status='PENDING_REFERENCE' then created_at else null end;
set constraints all immediate;
set constraints all deferred;
alter table wager_transactions alter column correlation_id set not null,
  add constraint wager_tx_reference_attempts_ck check(reference_attempts >= 0),
  add constraint wager_tx_pending_reference_ck check(
    (status='PENDING_REFERENCE')=(next_reference_attempt_at is not null)
    and (status<>'PENDING_REFERENCE' or reference_external_transaction_id is not null)),
  add constraint wager_tx_reference_state_ck check(
    (reference_transaction_id is not null)=(reference_external_transaction_id is not null and status='PROCESSED')),
  add constraint wager_tx_reference_not_allowed_ck check(
    kind not in ('BET','LOSS','OPENING') or reference_external_transaction_id is null);
alter table wager_transactions drop constraint wager_tx_reference_fk;
alter table wager_transactions add constraint wager_tx_reference_wallet_fk
  foreign key(reference_transaction_id,wallet_id) references wager_transactions(id,wallet_id);
create unique index wager_tx_single_reversal_uk on wager_transactions(reference_transaction_id,kind)
  where status='PROCESSED' and kind in ('REFUND','ROLLBACK');
create index wager_tx_pending_due_idx on wager_transactions(next_reference_attempt_at) where status='PENDING_REFERENCE';
create index wager_tx_pending_reference_idx on wager_transactions(provider_id,reference_external_transaction_id) where status='PENDING_REFERENCE';


create function wager_transactions_preserve() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'transação é registro de auditoria' using errcode='23514',constraint='wager_transactions_protect';
  end if;
  if old.status in ('PROCESSED','REJECTED','FAILED') then
    raise exception 'transação terminal é imutável' using errcode='23514',constraint='wager_transactions_protect';
  end if;
  if (to_jsonb(new)-array['status','failure_code','result_balance','result_currency','reference_transaction_id','reference_attempts','next_reference_attempt_at','processed_at'])
    is distinct from (to_jsonb(old)-array['status','failure_code','result_balance','result_currency','reference_transaction_id','reference_attempts','next_reference_attempt_at','processed_at']) then
    raise exception 'identidade da transação é imutável' using errcode='23514',constraint='wager_transactions_protect';
  end if;
  if new.status is distinct from old.status and not (
    (old.status='PENDING' and new.status in ('PROCESSED','REJECTED','PENDING_REFERENCE'))
    or (old.status='PENDING_REFERENCE' and new.status in ('PROCESSED','REJECTED'))) then
    raise exception 'transição de transação inválida' using errcode='23514',constraint='wager_transactions_protect';
  end if;
  return new;
end $$;
create trigger wager_transactions_protect before update or delete on wager_transactions
  for each row execute function wager_transactions_preserve();
create function wager_transactions_reject_truncate() returns trigger language plpgsql as $$
begin
  raise exception 'transações não podem ser removidas' using errcode='23514',constraint='wager_transactions_no_truncate';
end $$;
create trigger wager_transactions_no_truncate before truncate on wager_transactions
  for each statement execute function wager_transactions_reject_truncate();
create function wallets_preserve_identity() returns trigger language plpgsql as $$
begin
  if row(new.id,new.player_id,new.currency) is distinct from row(old.id,old.player_id,old.currency) then
    raise exception 'identidade da wallet é imutável' using errcode='23514',constraint='wallets_protect';
  end if;
  return new;
end $$;
create trigger wallets_protect before update on wallets
  for each row execute function wallets_preserve_identity();

create function wager_transactions_check_reference() returns trigger language plpgsql as $$
declare
  tx wager_transactions%rowtype;
  ref wager_transactions%rowtype;
begin
  select * into tx from wager_transactions where id=new.id;
  if tx.status<>'PROCESSED' or tx.reference_transaction_id is null then return null; end if;
  select * into ref from wager_transactions where id=tx.reference_transaction_id;
  if (tx.kind in ('REFUND','WIN') and ref.kind<>'BET')
    or (tx.kind='ROLLBACK' and ref.kind not in ('BET','WIN','REFUND')) then
    raise exception 'tipo de referência incompatível' using errcode='23514',constraint='wager_transactions_reference_valid';
  end if;
  if row(tx.provider_id,tx.wallet_id,tx.player_id,tx.currency,tx.round_id,tx.reference_external_transaction_id)
    is distinct from row(ref.provider_id,ref.wallet_id,ref.player_id,ref.currency,ref.round_id,ref.external_transaction_id) then
    raise exception 'identidade de referência incompatível' using errcode='23514',constraint='wager_transactions_reference_valid';
  end if;
  if ref.status<>'PROCESSED' then
    raise exception 'referência não processada' using errcode='23514',constraint='wager_transactions_reference_valid';
  end if;
  if tx.kind in ('REFUND','ROLLBACK') and tx.amount<>ref.amount then
    raise exception 'valor da reversão diverge da referência' using errcode='23514',constraint='wager_transactions_reference_valid';
  end if;
  return null;
end $$;
create constraint trigger wager_transactions_reference_valid after insert or update on wager_transactions
  deferrable initially deferred for each row execute function wager_transactions_check_reference();

create function wager_transactions_check_net_reversal() returns trigger language plpgsql as $$
declare
  tx wager_transactions%rowtype;
  ref wager_transactions%rowtype;
  bet uuid;
begin
  select * into tx from wager_transactions where id=new.id;
  if tx.status<>'PROCESSED' or tx.kind not in ('REFUND','ROLLBACK') then return null; end if;
  select * into ref from wager_transactions where id=tx.reference_transaction_id;
  if ref.kind='BET' then bet=ref.id;
  elsif tx.kind='ROLLBACK' and ref.kind='REFUND' then bet=ref.reference_transaction_id;
  else return null;
  end if;
  if exists(select 1 from wager_transactions r where r.reference_transaction_id=bet and r.kind='ROLLBACK' and r.status='PROCESSED')
    and exists(select 1 from wager_transactions f where f.reference_transaction_id=bet and f.kind='REFUND' and f.status='PROCESSED'
      and not exists(select 1 from wager_transactions undo where undo.reference_transaction_id=f.id and undo.kind='ROLLBACK' and undo.status='PROCESSED')) then
    raise exception 'referência já revertida em termos líquidos' using errcode='23514',constraint='wager_transactions_single_net_reversal';
  end if;
  return null;
end $$;
create constraint trigger wager_transactions_single_net_reversal after insert or update on wager_transactions
  deferrable initially deferred for each row execute function wager_transactions_check_net_reversal();

create or replace function wallet_ledger_entries_check_transaction() returns trigger language plpgsql as $$
declare
  tx wager_transactions%rowtype;
  owner wallets%rowtype;
  reference_direction text;
  expected_direction text;
begin
  select * into tx from wager_transactions where id=new.transaction_id;
  if not found then return null; end if;
  select * into owner from wallets where id=new.wallet_id;
  if tx.status<>'PROCESSED' or tx.kind='LOSS' then
    raise exception 'lançamento exige transação PROCESSED que move saldo' using errcode='23514',constraint='wallet_ledger_entries_match_transaction';
  end if;
  if tx.amount<>new.amount or tx.currency<>owner.currency or tx.player_id<>owner.player_id then
    raise exception 'lançamento diverge do valor, da moeda ou do player' using errcode='23514',constraint='wallet_ledger_entries_match_transaction';
  end if;
  if tx.kind='ROLLBACK' then
    select direction into reference_direction from wallet_ledger_entries where transaction_id=tx.reference_transaction_id and wallet_id=new.wallet_id;
    if reference_direction is null then
      raise exception 'reversão exige lançamento de referência' using errcode='23514',constraint='wallet_ledger_entries_match_transaction';
    end if;
    expected_direction=case reference_direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end;
  else
    expected_direction=case tx.kind when 'BET' then 'DEBIT' else 'CREDIT' end;
  end if;
  if new.direction<>expected_direction then
    raise exception 'direção incompatível com a transação' using errcode='23514',constraint='wallet_ledger_entries_match_transaction';
  end if;
  return null;
end $$;
`);
  }

  override down(): void {
    this
      .addSql(`create or replace function wallet_ledger_entries_check_transaction() returns trigger
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
      $$`);
    this.addSql(`
drop trigger wallets_protect on wallets;
drop function wallets_preserve_identity();
drop trigger wager_transactions_no_truncate on wager_transactions;
drop function wager_transactions_reject_truncate();
drop trigger wager_transactions_protect on wager_transactions;
drop function wager_transactions_preserve();
drop trigger wager_transactions_single_net_reversal on wager_transactions;
drop function wager_transactions_check_net_reversal();
drop trigger wager_transactions_reference_valid on wager_transactions;
drop function wager_transactions_check_reference();
drop index wager_tx_pending_reference_idx;
drop index wager_tx_pending_due_idx;
drop index wager_tx_single_reversal_uk;
alter table wager_transactions drop constraint wager_tx_reference_wallet_fk;
alter table wager_transactions add constraint wager_tx_reference_fk foreign key(reference_transaction_id) references wager_transactions(id);
alter table wager_transactions drop constraint wager_tx_reference_attempts_ck,
  drop constraint wager_tx_pending_reference_ck, drop constraint wager_tx_reference_state_ck,
  drop constraint wager_tx_reference_not_allowed_ck,
  drop column correlation_id, drop column next_reference_attempt_at, drop column reference_attempts;
`);
  }
}
