import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import {
  BadRequestException,
  Controller,
  Get,
  INestApplication,
  Logger,
  Param,
} from '@nestjs/common';

import { DomainError } from '../../src/modules/@shared/domain/errors/domain.error';
import { FailureCode } from '../../src/modules/@shared/domain/failure-code';
import { startApp } from '../support/http-app';

class ProbeError extends DomainError {
  constructor(code: FailureCode) {
    super(code, 'probe');
  }
}

const LEAKED_VALUE = 'segredo-1234.56';

@Controller('probe')
class ProbeController {
  @Get('domain/:code')
  domain(@Param('code') code: FailureCode): never {
    throw new ProbeError(code);
  }

  @Get('http-bad-request')
  httpBadRequest(): never {
    throw new BadRequestException('payload malformado');
  }

  @Get('crash')
  crash(): never {
    throw new Error(`Key (amount)=(${LEAKED_VALUE}) already exists`);
  }

  @Get('crash-multiline')
  crashMultiline(): never {
    throw new Error(`duplicate key\nDETAIL: Key (amount)=(${LEAKED_VALUE})`);
  }
}

describe('envelope de erro HTTP (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await startApp({}, { controllers: [ProbeController] }));
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['payload inválido', FailureCode.MONEY_INVALID_FORMAT, 400],
    ['recurso inexistente', FailureCode.RESOURCE_NOT_FOUND, 404],
    ['rejeição de negócio', FailureCode.CURRENCY_MISMATCH, 422],
    ['defeito interno', FailureCode.INTERNAL_ERROR, 500],
  ])('%s (%s) responde %d', async (_caso, code, status) => {
    const response = await fetch(`${baseUrl}/probe/domain/${code}`);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      statusCode: status,
      failureCode: code,
      message: 'probe',
    });
  });

  it('exceção HTTP do framework sai no mesmo envelope', async () => {
    const response = await fetch(`${baseUrl}/probe/http-bad-request`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      statusCode: 400,
      failureCode: FailureCode.REQUEST_INVALID,
      message: 'payload malformado',
    });
  });

  it('rota inexistente sai no mesmo envelope', async () => {
    const response = await fetch(`${baseUrl}/nao-existe`);
    const body = (await response.json()) as { failureCode: string };

    expect(response.status).toBe(404);
    expect(body.failureCode).toBe(FailureCode.RESOURCE_NOT_FOUND);
  });

  it.each([
    ['mensagem de uma linha', 'crash'],
    ['mensagem de várias linhas', 'crash-multiline'],
  ])(
    'erro inesperado com %s vira 500 sem vazar valor no corpo nem no log',
    async (_caso, route) => {
      const logged: unknown[][] = [];
      const spy = spyOn(Logger.prototype, 'error').mockImplementation(
        (...args: unknown[]) => {
          logged.push(args);
        },
      );

      try {
        const response = await fetch(`${baseUrl}/probe/${route}`);
        const text = await response.text();

        expect(response.status).toBe(500);
        expect(JSON.parse(text)).toEqual({
          statusCode: 500,
          failureCode: FailureCode.INTERNAL_ERROR,
          message: 'erro interno',
        });
        expect(text).not.toContain(LEAKED_VALUE);
        expect(logged.length).toBeGreaterThan(0);
        expect(JSON.stringify(logged)).not.toContain(LEAKED_VALUE);
      } finally {
        spy.mockRestore();
      }
    },
  );
});
