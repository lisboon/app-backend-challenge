import { FailureCode } from '../failure-code';
import { DomainError } from './domain.error';

export class MessageIdPayloadConflictError extends DomainError {
  constructor() {
    super(
      FailureCode.MESSAGE_ID_PAYLOAD_CONFLICT,
      'o messageId já foi recebido com outro conteúdo',
    );
  }
}

export class DuplicateMessageError extends Error {
  constructor() {
    super('mensagem já processada');
    this.name = new.target.name;
  }
}
