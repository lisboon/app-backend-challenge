export interface AppConfig {
  port: number;
  workerMetricsPort: number;
  outboxPollIntervalMs: number;
  databaseUrl: string;
  sqs: {
    region: string;
    endpoint: string | undefined;
    wagerQueueName: string;
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
    sqs: {
      region: required('AWS_REGION'),
      endpoint: env.SQS_ENDPOINT?.trim() || undefined,
      wagerQueueName: required('WAGER_QUEUE_NAME'),
      eventsQueueName: required('EVENTS_QUEUE_NAME'),
    },
  };

  if (
    config.sqs.eventsQueueName &&
    !/^[A-Za-z0-9_-]{1,75}\.fifo$/.test(config.sqs.eventsQueueName)
  ) {
    problems.push('EVENTS_QUEUE_NAME deve ser nome de fila FIFO');
  }

  if (problems.length > 0) {
    throw new InvalidConfigError(problems);
  }
  return config;
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
