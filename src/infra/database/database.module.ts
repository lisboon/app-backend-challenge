import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';

const CONNECTION_TIMEOUT_MS = 1000;

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Promise<MikroORM> =>
        MikroORM.init(
          defineConfig({
            clientUrl: config.databaseUrl,
            entities: [],
            discovery: { warnWhenNoEntities: false },
            driverOptions: { connectionTimeoutMillis: CONNECTION_TIMEOUT_MS },
          }),
        ),
    },
  ],
  exports: [MikroORM],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
