import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SQSClient =>
        new SQSClient({
          region: config.sqs.region,
          endpoint: config.sqs.endpoint,
          useQueueUrlAsEndpoint: false,
          maxAttempts: 1,
          requestHandler: { connectionTimeout: 1000, requestTimeout: 5000 },
        }),
    },
  ],
  exports: [SQSClient],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
