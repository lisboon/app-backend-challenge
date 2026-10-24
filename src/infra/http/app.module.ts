import { Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { HealthModule } from './health/health.module';
import { HttpErrorFilter } from './shared/errors/http-error.filter';

@Module({
  imports: [ConfigModule, DatabaseModule, QueueModule, HealthModule],
  providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
})
export class AppModule implements OnApplicationShutdown {
  private readonly logger = new Logger(AppModule.name);

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`encerramento concluído (${signal ?? 'close'})`);
  }
}
