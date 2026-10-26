import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';

import { DomainError } from '../../modules/@shared/domain/errors/domain.error';
import type { ResolvePendingWagerTransactionsUseCaseInterface } from '../../modules/wagering/usecase/resolve-pending/resolve-pending.usecase.dto';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';

export const RESOLVE_PENDING_WAGER_TRANSACTIONS = Symbol(
  'RESOLVE_PENDING_WAGER_TRANSACTIONS',
);

const BATCH_SIZE = 100;

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);

  private stopping = false;

  private timer: ReturnType<typeof setTimeout> | undefined;

  private current: Promise<void> | undefined;

  constructor(
    @Inject(RESOLVE_PENDING_WAGER_TRANSACTIONS)
    private readonly resolver: ResolvePendingWagerTransactionsUseCaseInterface,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.current = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.current;
    this.logger.log({ event: 'pending_reference_worker_stopped' });
  }

  private async run(): Promise<void> {
    let full = false;
    try {
      const result = await this.resolver.execute({ limit: BATCH_SIZE });
      full = result.attempted >= BATCH_SIZE;
      if (result.attempted > 0) {
        this.logger.log({
          event: 'pending_reference_batch_completed',
          attempted: result.attempted,
        });
      }
    } catch (error) {
      this.logger.error({
        event: 'pending_reference_cycle_failed',
        errorCode: error instanceof DomainError ? error.name : 'Error',
      });
    }
    if (!this.stopping) {
      this.timer = setTimeout(
        () => {
          this.current = this.run();
        },
        full ? 0 : this.config.pendingReferencePollIntervalMs,
      );
    }
  }
}
