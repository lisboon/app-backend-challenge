/**
 * Formato de erro da API.
 *
 * Derivado do `{ statusCode, error, message }` que eu uso em produção, com uma
 * diferença que o enunciado exige: o `failureCode`. Sem ele o provedor teria
 * de interpretar texto de mensagem para decidir se reenvia — e mensagem muda,
 * código não.
 */
export class HttpErrorResponseDto {
  statusCode: number;
  failureCode: string;
  message: string;
}
