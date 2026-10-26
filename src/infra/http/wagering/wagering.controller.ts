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
import type { SubmitWagerTransactionUseCaseOutputDto } from '../../../modules/wagering/usecase/submit/submit.usecase.dto';
import type { WagerTransactionOutputDto } from '../../../modules/wagering/usecase/wager-transaction.output.dto';
import {
  idempotencyKey,
  submitWagerTransactionContract,
} from '../../contract/wager-transaction.contract';
import { WAGERING_USE_CASES } from '../../wagering/wagering-use-cases.module';
import { CorrelationId } from '../shared/correlation-id.decorator';
import { parseRequest } from '../shared/validation/parse-request';
import {
  providerTransactionParams,
  transactionIdParam,
} from './wagering.request';

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
      ...parseRequest(submitWagerTransactionContract, body),
      idempotencyKey: idempotencyKeyFrom(key),
      correlationId,
    });
    response.status(httpStatusOf(result.status));
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

function httpStatusOf(status: WagerTransactionStatus): HttpStatus {
  switch (status) {
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
    default:
      return HttpStatus.CREATED;
  }
}
