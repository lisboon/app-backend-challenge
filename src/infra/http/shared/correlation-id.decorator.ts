import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { CorrelatedRequest } from './correlation';

export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const id = context
      .switchToHttp()
      .getRequest<CorrelatedRequest>().correlationId;
    if (id === undefined) {
      throw new Error('correlação HTTP não foi inicializada');
    }
    return id;
  },
);
