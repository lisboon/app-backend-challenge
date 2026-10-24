import { expect, it } from 'bun:test';

import {
  resolveCorrelationId,
  type CorrelatedRequest,
} from '../../../src/infra/http/shared/correlation';

it('resolve a correlação uma única vez sem alterar o header bruto', () => {
  const id = Bun.randomUUIDv7();

  const raw = id.toUpperCase();
  let generated = 0;

  const ids = {
    next: () => {
      generated++;
      return Bun.randomUUIDv7();
    },
  };

  const request: Pick<CorrelatedRequest, 'headers' | 'correlationId'> = {
    headers: { 'x-correlation-id': raw },
  };
  expect(resolveCorrelationId(request, ids)).toBe(id);
  expect(request.correlationId).toBe(id);
  expect(request.headers['x-correlation-id']).toBe(raw);
  expect(generated).toBe(0);

  const invalid: Pick<CorrelatedRequest, 'headers' | 'correlationId'> = {
    headers: { 'x-correlation-id': 'inválido' },
  };

  const resolved = resolveCorrelationId(invalid, ids);
  expect(resolveCorrelationId(invalid, ids)).toBe(resolved);
  expect(invalid.headers['x-correlation-id']).toBe('inválido');
  expect(generated).toBe(1);
});
