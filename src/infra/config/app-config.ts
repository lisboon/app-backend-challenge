export interface AppConfig {
  port: number;
  databaseUrl: string;
  sqs: {
    region: string;
    endpoint: string | undefined;
    wagerQueueName: string;
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
    port: parsePort(env.PORT, problems),
    databaseUrl,
    sqs: {
      region: required('AWS_REGION'),
      endpoint: env.SQS_ENDPOINT?.trim() || undefined,
      wagerQueueName: required('WAGER_QUEUE_NAME'),
    },
  };

  if (problems.length > 0) {
    throw new InvalidConfigError(problems);
  }
  return config;
}

function parsePort(raw: string | undefined, problems: string[]): number {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_PORT;
  }
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port > MAX_PORT) {
    problems.push(`PORT deve ser inteiro entre 0 e ${MAX_PORT}`);
    return DEFAULT_PORT;
  }
  return port;
}
