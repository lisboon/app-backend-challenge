import { Migration } from '@mikro-orm/migrations';

const preserve = (transitions: string): string => `
create or replace function wager_transactions_preserve() returns trigger language plpgsql as $$
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
  if new.status is distinct from old.status and not (${transitions}) then
    raise exception 'transição de transação inválida' using errcode='23514',constraint='wager_transactions_protect';
  end if;
  return new;
end $$`;

export class Migration20261025000007FailedTransitions extends Migration {
  override up(): void {
    this.addSql(
      preserve(`(old.status='PENDING' and new.status in ('PROCESSED','REJECTED','PENDING_REFERENCE','FAILED'))
    or (old.status='PENDING_REFERENCE' and new.status in ('PROCESSED','REJECTED','FAILED'))`),
    );
  }

  override down(): void {
    this.addSql(
      preserve(`(old.status='PENDING' and new.status in ('PROCESSED','REJECTED','PENDING_REFERENCE'))
    or (old.status='PENDING_REFERENCE' and new.status in ('PROCESSED','REJECTED'))`),
    );
  }
}
