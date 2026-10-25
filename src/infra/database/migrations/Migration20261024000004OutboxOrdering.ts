import { Migration } from '@mikro-orm/migrations';

export class Migration20261024000004OutboxOrdering extends Migration {
  override up(): void {
    this.addSql(
      'alter table outbox_messages add column sequence bigint generated always as identity',
    );
    this.addSql(
      'alter table outbox_messages add constraint outbox_sequence_uk unique (sequence)',
    );
    this
      .addSql(`create or replace function outbox_messages_preserve_event() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'evento da outbox não pode ser removido' using errcode = '23514', constraint = 'outbox_event_immutable';
        end if;
        if row(new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at, new.sequence)
          is distinct from row(old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at, old.sequence) then
          raise exception 'evento da outbox é imutável' using errcode = '23514', constraint = 'outbox_event_immutable';
        end if;
        return new;
      end $$`);
    this.addSql('drop index outbox_pending_aggregate_idx');
    this.addSql(
      'create index outbox_pending_aggregate_idx on outbox_messages (aggregate_id, sequence) where published_at is null',
    );
    this
      .addSql(`create function outbox_messages_no_truncate() returns trigger language plpgsql as $$
      begin
        raise exception 'eventos da outbox não podem ser removidos' using errcode = '23514', constraint = 'outbox_event_no_truncate';
      end $$`);
    this.addSql(
      'create trigger outbox_event_no_truncate before truncate on outbox_messages for each statement execute function outbox_messages_no_truncate()',
    );
  }

  override down(): void {
    this
      .addSql(`create or replace function outbox_messages_preserve_event() returns trigger language plpgsql as $$
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
    this.addSql('drop trigger outbox_event_no_truncate on outbox_messages');
    this.addSql('drop function outbox_messages_no_truncate()');
    this.addSql('drop index outbox_pending_aggregate_idx');
    this.addSql('alter table outbox_messages drop column sequence');
    this.addSql(
      'create index outbox_pending_aggregate_idx on outbox_messages (aggregate_id, occurred_at, id) where published_at is null',
    );
  }
}
