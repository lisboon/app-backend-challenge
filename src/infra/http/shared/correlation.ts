import type { Request } from 'express';
import { z } from 'zod';

import type { IdGenerator } from '../../../modules/@shared/gateway/id-generator.gateway';

export interface CorrelatedRequest extends Request {
  correlationId?: string;
}

export function resolveCorrelationId(
  request: Pick<CorrelatedRequest, 'headers' | 'correlationId'>,
  ids: IdGenerator,
): string {
  if (request.correlationId === undefined) {
    const result = z.uuid().safeParse(request.headers['x-correlation-id']);
    request.correlationId = result.success
      ? result.data.toLowerCase()
      : ids.next();
  }
  return request.correlationId;
}
