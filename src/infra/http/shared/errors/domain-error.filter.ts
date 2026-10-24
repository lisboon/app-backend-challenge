import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

import { DomainError } from '../../../../domain/@shared/domain/errors/domain.error';
import { FailureKind } from '../../../../domain/@shared/domain/failure-code';

/**
 * Um filtro só, sobre a base `DomainError`, em vez de um por classe de erro.
 *
 * O enunciado exige que a distinção entre payload inválido, conflito de
 * idempotência e rejeição de negócio seja consistente **entre todos os
 * endpoints** (seção 9). Tabela de mapeamento espalhada em um filtro por erro
 * é exatamente como essa consistência se perde: alguém adiciona um erro novo e
 * esquece o filtro, e a rota devolve 500.
 *
 * Aqui, erro de domínio novo sem entrada na tabela é erro de compilação.
 */
const STATUS_BY_KIND: Readonly<Record<FailureKind, HttpStatus>> = {
  [FailureKind.CONTRACT]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureKind.CONFLICT]: HttpStatus.CONFLICT,
  [FailureKind.NOT_FOUND]: HttpStatus.NOT_FOUND,
  /**
   * Rejeição de negócio não é erro de requisição: a operação foi aceita,
   * registrada e auditável, e o desfecho foi negativo. O status fica em 422
   * **apenas** quando a rejeição impede a criação do recurso. O fluxo de
   * submissão de transação responde 201 com `status: "REJECTED"` e o
   * `failureCode` no corpo, porque lá existe transação persistida para
   * consultar depois.
   */
  [FailureKind.BUSINESS]: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const statusCode = STATUS_BY_KIND[exception.failureKind];

    response.status(statusCode).json({
      statusCode,
      failureCode: exception.failureCode,
      message: exception.message,
    });
  }
}
