import { Module } from '@nestjs/common';

import { WageringUseCasesModule } from '../../wagering/wagering-use-cases.module';
import { WageringController } from './wagering.controller';

@Module({
  imports: [WageringUseCasesModule],
  controllers: [WageringController],
})
export class WageringModule {}
