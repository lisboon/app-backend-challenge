import { DomainError } from '../../modules/@shared/domain/errors/domain.error';

export function errorNameOf(error: unknown): string {
  return error instanceof DomainError
    ? error.name
    : error instanceof Error
      ? error.constructor.name
      : 'UnknownError';
}
