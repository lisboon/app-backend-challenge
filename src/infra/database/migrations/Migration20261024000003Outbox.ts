import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000003Outbox extends Migration {
  override up(): void {
    this.addSql(`create table outbox_messages (
      id uuid constraint outbox_messages_pk primary key,
      aggregate_id uuid not null, event_type text not null, payload jsonb not null,
      occurred_at timestamptz not null, attempts integer not null default 0,
      next_attempt_at timestamptz not null, published_at timestamptz, last_error text,
      constraint outbox_attempts_ck check (attempts >= 0),
      constraint outbox_published_at_ck check (published_at is null or published_at >= occurred_at)
    )`);
    this.addSql(
      'create index outbox_pending_due_idx on outbox_messages (next_attempt_at) where published_at is null',
    );
    this.addSql(
      'create index outbox_pending_aggregate_idx on outbox_messages (aggregate_id, occurred_at, id) where published_at is null',
    );
    this
      .addSql(`create function outbox_messages_preserve_event() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'evento da outbox não pode ser removido' using errcode = '23514', constraint = 'outbox_event_immutable';
        end if;
        if row(new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
          is distinct from row(old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'evento da outbox é imutável' using errcode = '23514', constraint = 'outbox_event_immutable';
        end if;
        return new;
      end $$`);
    this.addSql(
      'create trigger outbox_event_immutable before update or delete on outbox_messages for each row execute function outbox_messages_preserve_event()',
    );
  }

  override down(): void {
    this.addSql('drop table outbox_messages');
    this.addSql('drop function outbox_messages_preserve_event()');
  }
}
