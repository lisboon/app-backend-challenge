import { Global, Module } from '@nestjs/common';

import type { Clock } from '../../modules/@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../modules/@shared/gateway/id-generator.gateway';

export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const CLOCK = Symbol('CLOCK');

@Global()
@Module({
  providers: [
    {
      provide: ID_GENERATOR,
      useValue: {
        next: (): string => Bun.randomUUIDv7(),
      } satisfies IdGenerator,
    },
    {
      provide: CLOCK,
      useValue: { now: (): Date => new Date() } satisfies Clock,
    },
  ],
  exports: [ID_GENERATOR, CLOCK],
})
export class RuntimeModule {}
