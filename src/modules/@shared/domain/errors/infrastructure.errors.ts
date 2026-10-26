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

export class EventPublicationError extends Error {
  constructor(readonly code: string) {
    super('falha na publicação do evento');
    this.name = new.target.name;
  }
}
