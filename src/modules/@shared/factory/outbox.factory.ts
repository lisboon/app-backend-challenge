import type { TransactionManager } from '../domain/transaction/transaction-manager';
import type { Clock } from '../gateway/clock.gateway';
import type { EventPublisherGateway } from '../gateway/event-publisher.gateway';
import type { OutboxMonitor } from '../gateway/outbox-monitor.gateway';
import { OutboxMessageRepository } from '../repository/outbox-message.repository';
import { PublishOutboxUseCase } from '../usecase/publish-outbox/publish-outbox.usecase';

export const OutboxFactory = {
  create(dependencies: {
    transactions: TransactionManager;
    clock: Clock;
    publisher: EventPublisherGateway;
    monitor: OutboxMonitor;
  }): PublishOutboxUseCase {
    return new PublishOutboxUseCase(
      dependencies.transactions,
      new OutboxMessageRepository(),
      dependencies.publisher,
      dependencies.clock,
      dependencies.monitor,
    );
  },
};
