import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { AppModule } from './app.module';
import { configureHttpApplication } from './shared/configure-http-application';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true }),
  });
  configureHttpApplication(app);
  app.enableShutdownHooks();
  await app.listen(app.get<AppConfig>(APP_CONFIG).port);
}
void bootstrap();
