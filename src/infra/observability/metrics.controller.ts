import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Registry } from 'prom-client';
import type { Response } from 'express';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(Registry) private readonly registry: Registry) {}

  @Get()
  async metrics(@Res() response: Response): Promise<void> {
    response
      .type(this.registry.contentType)
      .send(await this.registry.metrics());
  }
}
