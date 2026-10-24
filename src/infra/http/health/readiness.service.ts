import { Inject, Injectable, Logger } from '@nestjs/common';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../config/config.module';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  status: DependencyStatus;
  checks: {
    postgres: DependencyStatus;
    sqs: DependencyStatus;
  };
}

const PROBE_TIMEOUT_MS = 2000;

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.probe('postgres', () =>
        this.orm.em.getConnection().execute('select 1'),
      ),
      this.probe('sqs', (abortSignal) =>
        Promise.all(
          [this.config.sqs.wagerQueueName, this.config.sqs.eventsQueueName].map(
            (QueueName) =>
              this.sqs.send(new GetQueueUrlCommand({ QueueName }), {
                abortSignal,
              }),
          ),
        ),
      ),
    ]);
    return {
      status: postgres === 'up' && sqs === 'up' ? 'up' : 'down',
      checks: { postgres, sqs },
    };
  }

  private async probe(
    dependency: string,
    run: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<DependencyStatus> {
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const timedOut = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
    try {
      await Promise.race([run(signal), timedOut]);
      return 'up';
    } catch (error) {
      this.logger.warn(`${dependency} indisponível: ${failureReason(error)}`);
      return 'down';
    }
  }
}

function failureReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string'
    ? `${error.name} ${code}`
    : `${error.name}: ${error.message}`;
}
