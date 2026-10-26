import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

import { DomainError } from '../../../../modules/@shared/domain/errors/domain.error';
import {
  FailureCode,
  FailureKind,
  failureKindOf,
} from '../../../../modules/@shared/domain/failure-code';
import type { IdGenerator } from '../../../../modules/@shared/gateway/id-generator.gateway';
import { ID_GENERATOR } from '../../../runtime/runtime.module';
import { resolveCorrelationId, type CorrelatedRequest } from '../correlation';
import { HttpErrorResponseDto } from './error.response.dto';

const STATUS_BY_KIND: Readonly<Record<FailureKind, HttpStatus>> = {
  [FailureKind.CONTRACT]: HttpStatus.BAD_REQUEST,
  [FailureKind.CONFLICT]: HttpStatus.CONFLICT,
  [FailureKind.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [FailureKind.BUSINESS]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureKind.TRANSIENT]: HttpStatus.SERVICE_UNAVAILABLE,
  [FailureKind.INTERNAL]: HttpStatus.INTERNAL_SERVER_ERROR,
};

const RETRY_AFTER_SECONDS = '1';

const INTERNAL_MESSAGE = 'erro interno';

const STACK_FRAME = /^\s+at\s/;

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  constructor(@Inject(ID_GENERATOR) private readonly ids: IdGenerator) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const body = this.toBody(exception);
    const response = host.switchToHttp().getResponse<Response>();
    if (!response.hasHeader('X-Correlation-Id')) {
      const request = host.switchToHttp().getRequest<CorrelatedRequest>();
      response.setHeader(
        'X-Correlation-Id',
        resolveCorrelationId(request, this.ids),
      );
    }
    if (failureKindOf(body.failureCode) === FailureKind.TRANSIENT) {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): HttpErrorResponseDto {
    if (exception instanceof DomainError) {
      return {
        statusCode: STATUS_BY_KIND[exception.failureKind],
        failureCode: exception.failureCode,
        message: exception.message,
      };
    }
    if (
      exception instanceof HttpException &&
      exception.getStatus() < HttpStatus.INTERNAL_SERVER_ERROR
    ) {
      return this.fromClientHttpException(exception);
    }
    this.logInternal(exception);
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      failureCode: FailureCode.INTERNAL_ERROR,
      message: INTERNAL_MESSAGE,
    };
  }

  private fromClientHttpException(
    exception: HttpException,
  ): HttpErrorResponseDto {
    const statusCode = exception.getStatus();
    return {
      statusCode,
      failureCode:
        statusCode === HttpStatus.NOT_FOUND
          ? FailureCode.RESOURCE_NOT_FOUND
          : FailureCode.REQUEST_INVALID,
      message: exception.message,
    };
  }

  private logInternal(exception: unknown): void {
    if (!(exception instanceof Error)) {
      this.logger.error('exceção não tipada', typeof exception);
      return;
    }
    const frames = (exception.stack ?? '')
      .split('\n')
      .filter((line) => STACK_FRAME.test(line))
      .join('\n');
    this.logger.error(exception.name, frames);
  }
}
