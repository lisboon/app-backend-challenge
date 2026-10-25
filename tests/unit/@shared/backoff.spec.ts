import { describe, expect, it } from 'bun:test';

import { exponentialBackoff } from '../../../src/modules/@shared/domain/backoff';

describe('exponentialBackoff', () => {
  it('cresce desde um segundo até cinco minutos e mantém o teto', () => {
    expect(
      Array.from({ length: 12 }, (_, index) => exponentialBackoff(index + 1)),
    ).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000,
      300000, 300000,
    ]);
    expect(exponentialBackoff(10000)).toBe(300000);
  });

  it('aceita outra base sem passar do teto', () => {
    expect(
      Array.from({ length: 9 }, (_, index) =>
        exponentialBackoff(index + 1, 2000),
      ),
    ).toEqual([2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000]);
  });

  it.each([0, -1, 1.5, Infinity, NaN])(
    'recusa tentativa inválida %s',
    (attempts) => {
      expect(() => exponentialBackoff(attempts)).toThrow();
    },
  );
});
