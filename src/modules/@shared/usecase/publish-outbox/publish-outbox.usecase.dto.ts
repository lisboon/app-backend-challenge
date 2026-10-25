import type { BaseUseCase } from '../base.usecase';

export interface PublishOutboxUseCaseInputDto {
  limit: number;
}
export interface PublishOutboxUseCaseOutputDto {
  attempted: number;
}
export type PublishOutboxUseCaseInterface = BaseUseCase<
  PublishOutboxUseCaseInputDto,
  PublishOutboxUseCaseOutputDto
>;
