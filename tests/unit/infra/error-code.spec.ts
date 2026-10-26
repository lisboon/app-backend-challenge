import { describe, expect, it } from 'bun:test';

import { errorCodeOf } from '../../../src/infra/observability/error-code';
import {
  EventPublicationError,
  InfrastructureUnavailableError,
} from '../../../src/modules/@shared/domain/errors/infrastructure.errors';

describe('errorCodeOf', () => {
  it.each([
    [
      'falha de publicação',
      new EventPublicationError('QueueDoesNotExist'),
      'QueueDoesNotExist',
    ],
    [
      'erro de domínio',
      new InfrastructureUnavailableError('PostgreSQL'),
      'InfrastructureUnavailableError',
    ],
    [
      'erro do SDK com Code',
      Object.assign(new Error('x'), { Code: 'Throttling' }),
      'Throttling',
    ],
    [
      'erro de rede com code',
      Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
      'ECONNREFUSED',
    ],
    [
      'SQLSTATE do driver',
      Object.assign(new Error('x'), { code: '53300' }),
      '53300',
    ],
    ['erro sem código', new TypeError('x'), 'TypeError'],
    ['valor que não é erro', 'texto', 'UnknownError'],
    ['nulo', null, 'UnknownError'],
  ])('%s vira um código estável', (_caso, error, code) => {
    expect(errorCodeOf(error)).toBe(code);
  });
});
