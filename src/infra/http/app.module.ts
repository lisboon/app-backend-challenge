import { Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ObservabilityModule } from '../observability/observability.module';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { HealthModule } from './health/health.module';
import { HttpErrorFilter } from './shared/errors/http-error.filter';
import { WageringModule } from './wagering/wagering.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule,
    RuntimeModule,
    ObservabilityModule,
    DatabaseModule,
    QueueModule,
    HealthModule,
    WalletModule,
    WageringModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
})
export class AppModule implements OnApplicationShutdown {
  private readonly logger = new Logger(AppModule.name);

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`encerramento concluído (${signal ?? 'close'})`);
  }
}
