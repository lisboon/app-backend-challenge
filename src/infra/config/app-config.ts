export interface AppConfig {
  port: number;
  workerMetricsPort: number;
  outboxPollIntervalMs: number;
  pendingReferencePollIntervalMs: number;
  pendingReferenceTtlSeconds: number;
  consumerRetryBaseSeconds: number;
  consumerConcurrency: number;
  databaseUrl: string;
  databasePoolMax: number;
  sqs: {
    region: string;
    endpoint: string | undefined;
    wagerQueueName: string;
    wagerDeadLetterQueueName: string;
    eventsQueueName: string;
  };
}

export class InvalidConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`configuração inválida: ${problems.join('; ')}`);
    this.name = 'InvalidConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;
const POSTGRES_URL = /^postgres(ql)?:\/\//;
const FIFO_QUEUE = /^[A-Za-z0-9_-]{1,75}\.fifo$/;

export const DEFAULT_DATABASE_POOL_MAX = 15;

const NON_CONSUMER_CONNECTIONS = 3;

export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`${name} ausente`);
      return '';
    }
    return value;
  };

  const databaseUrl = required('DATABASE_URL');
  if (databaseUrl && !POSTGRES_URL.test(databaseUrl)) {
    problems.push(
      'DATABASE_URL deve usar o esquema postgres:// ou postgresql://',
    );
  }

  const config: AppConfig = {
    port: parseInteger(env.PORT, 'PORT', DEFAULT_PORT, 0, MAX_PORT, problems),
    workerMetricsPort: parseInteger(
      env.WORKER_METRICS_PORT,
      'WORKER_METRICS_PORT',
      3001,
      0,
      MAX_PORT,
      problems,
    ),
    outboxPollIntervalMs: parseInteger(
      env.OUTBOX_POLL_INTERVAL_MS,
      'OUTBOX_POLL_INTERVAL_MS',
      500,
      1,
      2_147_483_647,
      problems,
    ),
    databaseUrl,
    databasePoolMax: parseInteger(
      env.DATABASE_POOL_MAX,
      'DATABASE_POOL_MAX',
      DEFAULT_DATABASE_POOL_MAX,
      2,
      200,
      problems,
    ),
    pendingReferencePollIntervalMs: parseInteger(
      env.PENDING_REFERENCE_POLL_INTERVAL_MS,
      'PENDING_REFERENCE_POLL_INTERVAL_MS',
      1000,
      1,
      2_147_483_647,
      problems,
    ),
    pendingReferenceTtlSeconds: parseInteger(
      env.PENDING_REFERENCE_TTL_SECONDS,
      'PENDING_REFERENCE_TTL_SECONDS',
      3600,
      1,
      2_147_483_647,
      problems,
    ),
    consumerRetryBaseSeconds: parseInteger(
      env.CONSUMER_RETRY_BASE_SECONDS,
      'CONSUMER_RETRY_BASE_SECONDS',
      2,
      1,
      300,
      problems,
    ),
    consumerConcurrency: parseInteger(
      env.CONSUMER_CONCURRENCY,
      'CONSUMER_CONCURRENCY',
      10,
      1,
      100,
      problems,
    ),
    sqs: {
      region: required('AWS_REGION'),
      endpoint: env.SQS_ENDPOINT?.trim() || undefined,
      wagerQueueName: required('WAGER_QUEUE_NAME'),
      wagerDeadLetterQueueName: required('WAGER_DLQ_NAME'),
      eventsQueueName: required('EVENTS_QUEUE_NAME'),
    },
  };

  for (const [name, value] of [
    ['WAGER_QUEUE_NAME', config.sqs.wagerQueueName],
    ['WAGER_DLQ_NAME', config.sqs.wagerDeadLetterQueueName],
    ['EVENTS_QUEUE_NAME', config.sqs.eventsQueueName],
  ] as const) {
    if (value && !FIFO_QUEUE.test(value)) {
      problems.push(`${name} deve ser nome de fila FIFO`);
    }
  }

  if (problems.length > 0) {
    throw new InvalidConfigError(problems);
  }
  return config;
}

export function assertWorkerConfig(config: AppConfig): void {
  if (
    config.consumerConcurrency + NON_CONSUMER_CONNECTIONS >
    config.databasePoolMax
  ) {
    throw new InvalidConfigError([
      `CONSUMER_CONCURRENCY deve deixar ${NON_CONSUMER_CONNECTIONS} conexões de DATABASE_POOL_MAX para outbox, pendências e readiness`,
    ]);
  }
}

function parseInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  problems: string[],
): number {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    problems.push(`${name} deve ser inteiro entre ${minimum} e ${maximum}`);
    return fallback;
  }
  return parsed;
}
