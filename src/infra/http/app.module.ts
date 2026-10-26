import { Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { ObservabilityModule } from '../observability/observability.module';
import { QueueModule } from '../queue/queue.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { HealthModule } from './health/health.module';
import { AuthGuard } from './shared/auth/auth.guard';
import {
  AnonymousAuthenticator,
  REQUEST_AUTHENTICATOR,
} from './shared/auth/request-authenticator';
import { CorrelationInterceptor } from './shared/correlation.interceptor';
import { HttpErrorFilter } from './shared/errors/http-error.filter';
import { HttpKeepAlive } from './shared/http-keep-alive';
import { RequestObservabilityMiddleware } from './shared/request-observability.middleware';
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
  providers: [
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: REQUEST_AUTHENTICATOR, useClass: AnonymousAuthenticator },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor },
    HttpKeepAlive,
    RequestObservabilityMiddleware,
  ],
})
export class AppModule implements OnApplicationShutdown {
  private readonly logger = new Logger(AppModule.name);

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`encerramento concluído (${signal ?? 'close'})`);
  }
}
