import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const logger = new ConsoleLogger({ json: true });
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger,
  });
  app.enableShutdownHooks(['SIGINT']);
  process.once('SIGTERM', (): void => {
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({
          event: 'worker_shutdown_failed',
          errorCode: error instanceof Error ? error.name : 'UnknownError',
        });
        process.exit(1);
      },
    );
  });
}
void bootstrap();
