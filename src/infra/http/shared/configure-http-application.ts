import type { INestApplication } from '@nestjs/common';

import { RequestObservabilityMiddleware } from './request-observability.middleware';

export function configureHttpApplication(app: INestApplication): void {
  const observability = app.get(RequestObservabilityMiddleware);
  app.use(observability.use.bind(observability));
}
