import { Migration } from '@mikro-orm/migrations';

export class Migration20261025000006Inbox extends Migration {
  override up(): void {
    this.addSql(`create table inbox_messages (
      consumer_name text not null, message_id text not null, payload_hash text not null,
      received_at timestamptz not null, processed_at timestamptz,
      constraint inbox_messages_pk primary key (consumer_name, message_id),
      constraint inbox_payload_hash_ck check (payload_hash ~ '^v1:[0-9a-f]{64}$'),
      constraint inbox_processed_at_ck check (processed_at is null or processed_at >= received_at)
    )`);
    this
      .addSql(`create function inbox_messages_preserve() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'mensagem da inbox não pode ser removida' using errcode = '23514', constraint = 'inbox_message_immutable';
        end if;
        if old.processed_at is not null then
          raise exception 'mensagem processada da inbox é imutável' using errcode = '23514', constraint = 'inbox_message_immutable';
        end if;
        if row(new.consumer_name, new.message_id, new.payload_hash, new.received_at)
          is distinct from row(old.consumer_name, old.message_id, old.payload_hash, old.received_at) then
          raise exception 'identidade da mensagem da inbox é imutável' using errcode = '23514', constraint = 'inbox_message_immutable';
        end if;
        return new;
      end $$`);
    this.addSql(
      'create trigger inbox_message_immutable before update or delete on inbox_messages for each row execute function inbox_messages_preserve()',
    );
    this
      .addSql(`create function inbox_messages_no_truncate() returns trigger language plpgsql as $$
      begin
        raise exception 'mensagens da inbox não podem ser removidas' using errcode = '23514', constraint = 'inbox_message_no_truncate';
      end $$`);
    this.addSql(
      'create trigger inbox_message_no_truncate before truncate on inbox_messages for each statement execute function inbox_messages_no_truncate()',
    );
  }

  override down(): void {
    this.addSql('drop table inbox_messages');
    this.addSql('drop function inbox_messages_no_truncate()');
    this.addSql('drop function inbox_messages_preserve()');
  }
}
