import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { IdempotencyKeyMissingError } from '../../../modules/wagering/domain/errors/wagering.errors';
import { WagerTransactionStatus } from '../../../modules/wagering/domain/wager-transaction.entity';
import type { WageringUseCases } from '../../../modules/wagering/factory/wagering.factory';
import type { SubmitWagerTransactionUseCaseOutputDto } from '../../../modules/wagering/usecase/submit-wager-transaction/submit-wager-transaction.usecase.dto';
import type { WagerTransactionOutputDto } from '../../../modules/wagering/usecase/wager-transaction.output.dto';
import { CorrelationId } from '../shared/correlation-id.decorator';
import { parseRequest } from '../shared/validation/parse-request';
import {
  idempotencyKey,
  providerTransactionParams,
  submitWagerTransactionRequest,
  transactionIdParam,
} from './wagering.request';

export const WAGERING_USE_CASES = Symbol('WAGERING_USE_CASES');

@Controller()
export class WageringController {
  constructor(
    @Inject(WAGERING_USE_CASES) private readonly useCases: WageringUseCases,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') key: string | undefined,
    @CorrelationId() correlationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmitWagerTransactionUseCaseOutputDto> {
    const result = await this.useCases.submit.execute({
      ...parseRequest(submitWagerTransactionRequest, body),
      idempotencyKey: idempotencyKeyFrom(key),
      correlationId,
    });
    response.status(
      result.status === WagerTransactionStatus.Rejected
        ? HttpStatus.UNPROCESSABLE_ENTITY
        : result.status === WagerTransactionStatus.PendingReference
          ? HttpStatus.ACCEPTED
          : HttpStatus.CREATED,
    );
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  findById(
    @Param('transactionId') transactionId: string,
  ): Promise<WagerTransactionOutputDto> {
    return this.useCases.findById.execute({
      id: parseRequest(transactionIdParam, transactionId),
    });
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  findByExternalId(
    @Param() params: unknown,
  ): Promise<WagerTransactionOutputDto> {
    return this.useCases.findByExternalId.execute(
      parseRequest(providerTransactionParams, params),
    );
  }
}

function idempotencyKeyFrom(header: string | undefined): string {
  const key = header?.trim();
  if (!key) {
    throw new IdempotencyKeyMissingError();
  }
  return parseRequest(idempotencyKey, key);
}
