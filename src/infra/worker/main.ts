import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new ConsoleLogger({ json: true }),
  });
  app.enableShutdownHooks(['SIGINT']);
  process.once('SIGTERM', (): void => {
    void app.close().then(() => process.exit(0));
  });
}
void bootstrap();
