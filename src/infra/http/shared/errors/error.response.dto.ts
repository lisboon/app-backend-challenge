import { FailureCode } from '../../../../modules/@shared/domain/failure-code';

export class HttpErrorResponseDto {
  statusCode: number;
  failureCode: FailureCode;
  message: string;
}
