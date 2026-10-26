import { describe, expect, it } from 'bun:test';

import {
  isTransientFailure,
  lockConflictReason,
} from '../../../src/infra/database/database-errors';

describe('lockConflictReason', () => {
  it.each([
    ['55P03', 'lock_timeout'],
    ['40P01', 'deadlock'],
    ['40001', 'serialization'],
  ] as const)(
    '%s é conflito de lock %s e continua transitório',
    (code, reason) => {
      expect(lockConflictReason({ code })).toBe(reason);
      expect(isTransientFailure({ code })).toBe(true);
    },
  );

  it('acha o código do driver embrulhado em cause', () => {
    expect(
      lockConflictReason(
        new Error('falha do ORM', { cause: { code: '40P01' } }),
      ),
    ).toBe('deadlock');
  });

  it.each([
    { code: '23505' },
    { code: 'ECONNRESET' },
    { code: 55 },
    new Error('sem código'),
    'texto',
    undefined,
  ])('não classifica como conflito: %p', (error) => {
    expect(lockConflictReason(error)).toBeUndefined();
  });
});

describe('isTransientFailure', () => {
  it.each([
    ['sessão ociosa encerrada pelo servidor', { code: '25P03' }],
    [
      'cliente que perdeu a conexão',
      new Error(
        'Client has encountered a connection error and is not queryable',
      ),
    ],
    ['cliente já fechado', new Error('Client was closed and is not queryable')],
    ['servidor sem recurso', { code: '53000' }],
    ['disco cheio', { code: '53100' }],
    ['servidor sem memória', { code: '53200' }],
    ['conexões esgotadas no servidor', { code: '53300' }],
    ['limite de configuração excedido', { code: '53400' }],
    ['query cancelada', { code: '57014' }],
    ['host inalcançável', { code: 'EHOSTUNREACH' }],
    ['rede inalcançável', { code: 'ENETUNREACH' }],
  ])('%s é transitório', (_caso, error) => {
    expect(isTransientFailure(error)).toBe(true);
  });

  it.each([
    { code: '23505' },
    { code: '22021' },
    { code: '25006' },
    { code: '08P01' },
    new Error('invariante violada'),
  ])('erro que não é de conexão continua interno: %p', (error) => {
    expect(isTransientFailure(error)).toBe(false);
  });
});
