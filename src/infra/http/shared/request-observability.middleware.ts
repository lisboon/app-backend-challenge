import {
  Inject,
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Histogram, Registry } from 'prom-client';

const UNMATCHED_ROUTE = 'unmatched';

const QUIET_ROUTES = new Set(['/health/live', '/health/ready', '/metrics']);

@Injectable()
export class RequestObservabilityMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HttpRequest');

  private readonly duration: Histogram<'method' | 'route' | 'status'>;

  constructor(@Inject(Registry) registry: Registry) {
    this.duration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Latência das requisições HTTP por rota',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    });
  }

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = performance.now();
    response.once('finish', () => {
      const route = routeOf(request);
      const status = response.statusCode;
      const seconds = (performance.now() - startedAt) / 1000;
      this.duration.observe(
        { method: request.method, route, status: String(status) },
        seconds,
      );
      if (!QUIET_ROUTES.has(route)) {
        this.logger.log({
          event: 'http_request',
          method: request.method,
          route,
          status,
          durationMs: Math.round(seconds * 1000),
          correlationId: response.getHeader('X-Correlation-Id'),
        });
      }
    });
    next();
  }
}

function routeOf(request: Request): string {
  const path = (request.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? request.baseUrl + path : UNMATCHED_ROUTE;
}
