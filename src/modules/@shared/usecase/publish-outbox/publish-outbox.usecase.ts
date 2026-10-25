import { EventPublicationError } from '../../domain/errors/infrastructure.errors';
import type { OutboxMessage } from '../../domain/outbox/outbox-message.entity';
import type {
  TransactionContext,
  TransactionManager,
} from '../../domain/transaction/transaction-manager';
import type { Clock } from '../../gateway/clock.gateway';
import type { EventPublisherGateway } from '../../gateway/event-publisher.gateway';
import type { OutboxMonitor } from '../../gateway/outbox-monitor.gateway';
import type { PendingOutboxGateway } from '../../gateway/outbox.gateway';
import type {
  PublishOutboxUseCaseInputDto,
  PublishOutboxUseCaseOutputDto,
  PublishOutboxUseCaseInterface,
} from './publish-outbox.usecase.dto';

const PUBLISH_CONCURRENCY = 10;

export class PublishOutboxUseCase implements PublishOutboxUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly outbox: PendingOutboxGateway,
    private readonly publisher: EventPublisherGateway,
    private readonly clock: Clock,
    private readonly monitor: OutboxMonitor,
  ) {}

  async execute(
    input: PublishOutboxUseCaseInputDto,
  ): Promise<PublishOutboxUseCaseOutputDto> {
    const attempted = await this.transactions.execute(async (trx) => {
      const messages = await this.outbox.findDue(
        this.clock.now(),
        input.limit,
        trx,
      );
      return this.publishDue(messages, trx);
    });
    await this.recordLag();
    return { attempted };
  }

  private async publishDue(
    messages: OutboxMessage[],
    trx: TransactionContext,
  ): Promise<number> {
    const groups = new Map<string, OutboxMessage[]>();
    for (const message of messages) {
      const group = groups.get(message.aggregateId) ?? [];
      group.push(message);
      groups.set(message.aggregateId, group);
    }
    const wallets = [...groups.values()];
    let attempted = 0;
    for (
      let offset = 0;
      offset < wallets.length;
      offset += PUBLISH_CONCURRENCY
    ) {
      const results = await Promise.allSettled(
        wallets
          .slice(offset, offset + PUBLISH_CONCURRENCY)
          .map((group) => this.publishWallet(group, trx)),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
        attempted += result.value;
      }
    }
    return attempted;
  }

  private async publishWallet(
    messages: OutboxMessage[],
    trx: TransactionContext,
  ): Promise<number> {
    let attempted = 0;
    for (const message of messages) {
      if (!message.isDue(this.clock.now())) {
        break;
      }
      const published = await this.publish(message, trx);
      attempted += 1;
      if (!published) {
        break;
      }
    }
    return attempted;
  }

  private async recordLag(): Promise<void> {
    const oldest = await this.transactions.snapshot((trx) =>
      this.outbox.oldestPending(trx),
    );
    this.monitor.lag(
      oldest === null
        ? 0
        : Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000),
    );
  }

  private async publish(
    message: OutboxMessage,
    trx: TransactionContext,
  ): Promise<boolean> {
    try {
      await this.publisher.publish(message);
    } catch (error) {
      message.scheduleRetry(this.clock.now());
      this.monitor.retryScheduled(message);
      const code =
        error instanceof EventPublicationError ? error.code : 'Error';
      await this.outbox.update(message, code, trx);
      this.monitor.publicationFailed(message, code);
      return false;
    }
    message.markPublished(this.clock.now());
    await this.outbox.update(message, undefined, trx);
    this.monitor.published(message);
    return true;
  }
}
