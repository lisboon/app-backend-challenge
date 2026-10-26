import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Registry } from 'prom-client';

import type { PublishOutboxUseCaseInterface } from '../../modules/@shared/usecase/publish-outbox/publish-outbox.usecase.dto';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { errorCodeOf } from '../observability/error-code';

export const PUBLISH_OUTBOX = Symbol('PUBLISH_OUTBOX');

const BATCH_SIZE = 100;

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);

  private stopping = false;

  private timer: ReturnType<typeof setTimeout> | undefined;

  private current: Promise<void> | undefined;

  private server: Bun.Server<undefined> | undefined;

  constructor(
    @Inject(PUBLISH_OUTBOX)
    private readonly publisher: PublishOutboxUseCaseInterface,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Registry) private readonly registry: Registry,
  ) {}

  onModuleInit(): void {
    this.server = Bun.serve({
      port: this.config.workerMetricsPort,
      hostname: '0.0.0.0',
      fetch: async (request: Request): Promise<Response> =>
        new URL(request.url).pathname === '/metrics'
          ? new Response(await this.registry.metrics(), {
              headers: { 'content-type': this.registry.contentType },
            })
          : new Response('não encontrado', { status: 404 }),
    });
    this.current = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.current;
    await this.server?.stop(true);
    this.logger.log({ event: 'outbox_worker_stopped' });
  }

  private async run(): Promise<void> {
    let full = false;
    try {
      const result = await this.publisher.execute({ limit: BATCH_SIZE });
      full = result.attempted >= BATCH_SIZE;
      if (result.attempted > 0) {
        this.logger.log({
          event: 'outbox_batch_completed',
          attempted: result.attempted,
        });
      }
    } catch (error) {
      this.logger.error({
        event: 'outbox_cycle_failed',
        errorCode: errorCodeOf(error),
      });
    }
    if (!this.stopping) {
      this.timer = setTimeout(
        () => {
          this.current = this.run();
        },
        full ? 0 : this.config.outboxPollIntervalMs,
      );
    }
  }
}
