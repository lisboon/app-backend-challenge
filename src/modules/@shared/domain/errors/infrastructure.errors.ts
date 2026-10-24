import { FailureCode } from '../failure-code';
import { DomainError } from './domain.error';

export class InfrastructureUnavailableError extends DomainError {
  constructor(dependency: string) {
    super(
      FailureCode.INFRASTRUCTURE_UNAVAILABLE,
      `${dependency} indisponível; a mesma requisição pode ser reenviada`,
    );
  }
}
