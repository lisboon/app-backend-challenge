import { describe, expect, it } from 'bun:test';

import {
  InvalidConfigError,
  loadConfig,
} from '../../../src/infra/config/app-config';

const valid = {
  PORT: '3000',
  DATABASE_URL: 'postgresql://wager:segredo@db:5432/wager',
  AWS_REGION: 'us-east-1',
  SQS_ENDPOINT: 'http://sqs:4566',
  WAGER_QUEUE_NAME: 'wager-transactions.fifo',
};

const problemsOf = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof InvalidConfigError) {
      return [...error.problems];
    }
    throw error;
  }
  throw new Error('deveria ter recusado a configuração');
};

describe('loadConfig', () => {
  it('lê a configuração completa', () => {
    expect(loadConfig(valid)).toEqual({
      port: 3000,
      databaseUrl: valid.DATABASE_URL,
      sqs: {
        region: 'us-east-1',
        endpoint: 'http://sqs:4566',
        wagerQueueName: 'wager-transactions.fifo',
      },
    });
  });

  it('usa a porta 3000 quando PORT não é informada', () => {
    expect(loadConfig({ ...valid, PORT: undefined }).port).toBe(3000);
  });

  it('sem SQS_ENDPOINT usa o endpoint padrão da AWS', () => {
    expect(
      loadConfig({ ...valid, SQS_ENDPOINT: '  ' }).sqs.endpoint,
    ).toBeUndefined();
  });

  it('lista todas as variáveis ausentes de uma vez', () => {
    expect(problemsOf({})).toEqual([
      'DATABASE_URL ausente',
      'AWS_REGION ausente',
      'WAGER_QUEUE_NAME ausente',
    ]);
  });

  it.each([['abc'], ['-1'], ['3.5'], ['70000']])('recusa PORT %s', (port) => {
    expect(problemsOf({ ...valid, PORT: port })).toEqual([
      'PORT deve ser inteiro entre 0 e 65535',
    ]);
  });

  it('recusa DATABASE_URL de outro banco sem expor a credencial', () => {
    const problems = problemsOf({
      ...valid,
      DATABASE_URL: 'mysql://root:segredo@db/wager',
    });

    expect(problems).toEqual([
      'DATABASE_URL deve usar o esquema postgres:// ou postgresql://',
    ]);
    expect(problems.join()).not.toContain('segredo');
  });
});
