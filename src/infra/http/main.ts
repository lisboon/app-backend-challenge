import { NestFactory } from '@nestjs/core';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(app.get<AppConfig>(APP_CONFIG).port);
}
void bootstrap();
