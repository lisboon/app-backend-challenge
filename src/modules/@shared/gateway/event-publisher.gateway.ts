import type { OutboxMessage } from '../domain/outbox/outbox-message.entity';

export interface EventPublisherGateway {
  publish(message: OutboxMessage): Promise<void>;
}
