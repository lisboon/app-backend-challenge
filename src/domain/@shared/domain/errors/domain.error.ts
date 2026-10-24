import { FailureCode, FailureKind, failureKindOf } from '../failure-code';

export abstract class DomainError extends Error {
  readonly failureCode: FailureCode;

  protected constructor(failureCode: FailureCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.failureCode = failureCode;
  }

  get failureKind(): FailureKind {
    return failureKindOf(this.failureCode);
  }
}
