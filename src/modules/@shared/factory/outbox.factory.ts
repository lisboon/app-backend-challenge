import type { TransactionManager } from '../domain/transaction/transaction-manager';
import type { Clock } from '../gateway/clock.gateway';
import type { EventPublisherGateway } from '../gateway/event-publisher.gateway';
import type { OutboxMonitor } from '../gateway/outbox-monitor.gateway';
import { OutboxRepository } from '../repository/outbox.repository';
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
      new OutboxRepository(),
      dependencies.publisher,
      dependencies.clock,
      dependencies.monitor,
    );
  },
};
