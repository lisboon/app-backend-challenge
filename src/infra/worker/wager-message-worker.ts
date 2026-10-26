import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { exponentialBackoff } from '../../modules/@shared/domain/backoff';
import {
  FailureCode,
  FailureKind,
  failureKindOf,
} from '../../modules/@shared/domain/failure-code';
import type { InboxDelivery } from '../../modules/@shared/domain/inbox/inbox-message.entity';
import { payloadHash } from '../../modules/@shared/domain/payload-hash';
import type { RecordFailedWagerTransactionUseCaseInterface } from '../../modules/wagering/usecase/record-failure/record-failure.usecase.dto';
import type { SubmitWagerTransactionUseCaseInterface } from '../../modules/wagering/usecase/submit/submit.usecase.dto';
import { type AppConfig, assertWorkerConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import {
  wagerTransactionMessageContract,
  type WagerTransactionMessage,
} from '../contract/wager-transaction.contract';
import { errorCodeOf } from '../observability/error-code';
import type { ReceivedWagerMessage, WagerQueue } from '../queue/wager-queue';
import {
  dispositionOfFailure,
  type MessageDisposition,
} from './message-disposition';

export const WAGER_QUEUE = Symbol('WAGER_QUEUE');

export const SUBMIT_FOR_DELIVERY = Symbol('SUBMIT_FOR_DELIVERY');

export const RECORD_FAILURE_FOR_DELIVERY = Symbol(
  'RECORD_FAILURE_FOR_DELIVERY',
);

export const WAGER_CONSUMER_MONITOR = Symbol('WAGER_CONSUMER_MONITOR');

const WAGER_CONSUMER_NAME = 'wager-transactions';

const IDLE_AFTER_FAILURE_MS = 1000;

interface Handled {
  disposition: MessageDisposition;
  transactionId?: string;
}

const INVALID_MESSAGE: Handled = {
  disposition: {
    action: 'dead-letter',
    failureCode: FailureCode.MESSAGE_INVALID,
  },
};

export type SubmitForDelivery = (
  delivery: InboxDelivery,
) => SubmitWagerTransactionUseCaseInterface;

export type RecordFailureForDelivery = (
  delivery: InboxDelivery,
) => RecordFailedWagerTransactionUseCaseInterface;

export interface WagerConsumerMonitor {
  handled(disposition: MessageDisposition, seconds: number): void;
  settleFailed(disposition: MessageDisposition): void;
}

@Injectable()
export class WagerMessageWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerMessageWorker.name);

  private readonly abort = new AbortController();

  private stopping = false;

  private current: Promise<void> | undefined;

  constructor(
    @Inject(WAGER_QUEUE) private readonly queue: WagerQueue,
    @Inject(SUBMIT_FOR_DELIVERY) private readonly submitFor: SubmitForDelivery,
    @Inject(RECORD_FAILURE_FOR_DELIVERY)
    private readonly recordFailureFor: RecordFailureForDelivery,
    @Inject(WAGER_CONSUMER_MONITOR)
    private readonly monitor: WagerConsumerMonitor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    assertWorkerConfig(config);
  }

  onModuleInit(): void {
    this.current = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await this.current;
    this.logger.log({ event: 'wager_message_worker_stopped' });
  }

  private async run(): Promise<void> {
    await Promise.all(
      Array.from({ length: this.config.consumerConcurrency }, () =>
        this.consume(),
      ),
    );
  }

  private async consume(): Promise<void> {
    while (!this.stopping) {
      const message = await this.receive();
      if (message) {
        await this.handle(message);
      }
    }
  }

  private async receive(): Promise<ReceivedWagerMessage | undefined> {
    try {
      return await this.queue.receive(this.abort.signal);
    } catch (error) {
      if (!this.stopping) {
        this.logger.error({
          event: 'wager_message_receive_failed',
          errorCode: errorCodeOf(error),
        });
        await Bun.sleep(IDLE_AFTER_FAILURE_MS);
      }
      return undefined;
    }
  }

  private async handle(message: ReceivedWagerMessage): Promise<void> {
    const startedAt = performance.now();
    const parsed = parseMessage(message.body);
    const { disposition, transactionId } = parsed
      ? await this.submit(parsed)
      : INVALID_MESSAGE;
    const settled = await this.settle(message, disposition);
    const seconds = (performance.now() - startedAt) / 1000;
    if (settled) {
      this.monitor.handled(disposition, seconds);
    } else {
      this.monitor.settleFailed(disposition);
    }
    this.logger.log({
      event: 'wager_message_handled',
      messageId: parsed?.messageId,
      correlationId: parsed?.messageId,
      transactionId,
      providerId: parsed?.data.providerId,
      walletId: parsed?.data.walletId,
      action: disposition.action,
      failureCode:
        disposition.action === 'dead-letter'
          ? disposition.failureCode
          : undefined,
      receiveCount: message.receiveCount,
      settled,
      durationMs: Math.round(seconds * 1000),
    });
  }

  private async submit(message: WagerTransactionMessage): Promise<Handled> {
    const delivery: InboxDelivery = {
      consumerName: WAGER_CONSUMER_NAME,
      messageId: message.messageId,
      payloadHash: payloadHash({ type: message.type, data: message.data }),
    };
    try {
      const result = await this.submitFor(delivery).execute({
        ...message.data,
        correlationId: message.messageId,
      });
      return {
        disposition: { action: 'acknowledge', reason: 'processed' },
        transactionId: result.transactionId,
      };
    } catch (error) {
      const disposition = dispositionOfFailure(error);
      return isProcessingFailure(disposition)
        ? this.recordFailure(delivery, message)
        : { disposition };
    }
  }

  private async recordFailure(
    delivery: InboxDelivery,
    message: WagerTransactionMessage,
  ): Promise<Handled> {
    try {
      const { transactionId } = await this.recordFailureFor(delivery).execute({
        ...message.data,
        correlationId: message.messageId,
      });
      return {
        disposition: {
          action: 'dead-letter',
          failureCode: FailureCode.PROCESSING_FAILED,
        },
        transactionId: transactionId ?? undefined,
      };
    } catch (error) {
      const disposition = dispositionOfFailure(error);
      return {
        disposition: isProcessingFailure(disposition)
          ? { action: 'retry' }
          : disposition,
      };
    }
  }

  private async settle(
    message: ReceivedWagerMessage,
    disposition: MessageDisposition,
  ): Promise<boolean> {
    try {
      await this.apply(message, disposition);
      return true;
    } catch (error) {
      this.logger.error({
        event: 'wager_message_settle_failed',
        sqsMessageId: message.sqsMessageId,
        errorCode: errorCodeOf(error),
      });
      return false;
    }
  }

  private apply(
    message: ReceivedWagerMessage,
    disposition: MessageDisposition,
  ): Promise<void> {
    switch (disposition.action) {
      case 'acknowledge':
        return this.queue.acknowledge(message);
      case 'retry':
        return this.queue.retryLater(message, this.retryDelaySeconds(message));
      case 'dead-letter':
        return this.queue.sendToDeadLetter(message, disposition.failureCode);
    }
  }

  private retryDelaySeconds(message: ReceivedWagerMessage): number {
    return (
      exponentialBackoff(
        message.receiveCount,
        this.config.consumerRetryBaseSeconds * 1000,
      ) / 1000
    );
  }
}

function isProcessingFailure(disposition: MessageDisposition): boolean {
  return (
    disposition.action === 'dead-letter' &&
    failureKindOf(disposition.failureCode) === FailureKind.INTERNAL
  );
}

function parseMessage(body: string): WagerTransactionMessage | undefined {
  try {
    const result = wagerTransactionMessageContract.safeParse(JSON.parse(body));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
