import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

import type { IdGenerator } from '../../../modules/@shared/gateway/id-generator.gateway';
import { ID_GENERATOR } from '../../runtime/runtime.module';
import { resolveCorrelationId, type CorrelatedRequest } from './correlation';

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  constructor(@Inject(ID_GENERATOR) private readonly ids: IdGenerator) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const id = resolveCorrelationId(
      http.getRequest<CorrelatedRequest>(),
      this.ids,
    );
    http.getResponse<Response>().setHeader('X-Correlation-Id', id);
    return next.handle();
  }
}
