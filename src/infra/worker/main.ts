import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { errorCodeOf } from '../observability/error-code';
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
          errorCode: errorCodeOf(error),
        });
        process.exit(1);
      },
    );
  });
}
void bootstrap();
