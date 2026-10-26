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
