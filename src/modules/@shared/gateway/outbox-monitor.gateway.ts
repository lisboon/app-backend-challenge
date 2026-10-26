import type { OutboxMessage } from '../domain/outbox/outbox-message.entity';

export interface OutboxMonitor {
  published(message: OutboxMessage): void;
  retryScheduled(message: OutboxMessage): void;
  publicationFailed(message: OutboxMessage, errorCode: string): void;
  lag(seconds: number): void;
  lagUnavailable(error: unknown): void;
}
