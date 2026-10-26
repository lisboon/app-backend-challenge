import { DomainError } from '../../modules/@shared/domain/errors/domain.error';
import { EventPublicationError } from '../../modules/@shared/domain/errors/infrastructure.errors';

export function errorCodeOf(error: unknown): string {
  if (error instanceof EventPublicationError) {
    return error.code;
  }
  if (error instanceof DomainError) {
    return error.name;
  }
  const failure = error as { Code?: unknown; code?: unknown } | null;
  for (const code of [failure?.Code, failure?.code]) {
    if (typeof code === 'string') {
      return code;
    }
  }
  return error instanceof Error ? error.name : 'UnknownError';
}
