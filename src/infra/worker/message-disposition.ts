import { DomainError } from '../../modules/@shared/domain/errors/domain.error';
import { DuplicateMessageError } from '../../modules/@shared/domain/errors/inbox.errors';
import {
  FailureCode,
  FailureKind,
} from '../../modules/@shared/domain/failure-code';

export type MessageDisposition =
  | { action: 'acknowledge' }
  | { action: 'retry' }
  | { action: 'dead-letter'; failureCode: FailureCode };

export function dispositionOfFailure(error: unknown): MessageDisposition {
  if (error instanceof DuplicateMessageError) {
    return { action: 'acknowledge' };
  }
  if (!(error instanceof DomainError)) {
    return { action: 'dead-letter', failureCode: FailureCode.INTERNAL_ERROR };
  }
  return error.failureKind === FailureKind.TRANSIENT
    ? { action: 'retry' }
    : { action: 'dead-letter', failureCode: error.failureCode };
}
