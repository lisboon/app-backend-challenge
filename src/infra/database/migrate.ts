import { MikroORM } from '@mikro-orm/postgresql';

import { DEFAULT_DATABASE_POOL_MAX } from '../config/app-config';
import { ormConfig } from './orm.config';

type Command = 'up' | 'down' | 'status';

const COMMANDS: readonly string[] = ['up', 'down', 'status'];

async function run(orm: MikroORM, command: Command): Promise<unknown> {
  if (command === 'up') {
    return { applied: (await orm.migrator.up()).map((m) => m.name) };
  }
  if (command === 'down') {
    return { reverted: (await orm.migrator.down()).map((m) => m.name) };
  }
  return {
    executed: (await orm.migrator.getExecuted()).map((m) => m.name),
    pending: (await orm.migrator.getPending()).map((m) => m.name),
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  const command = process.argv[2] ?? 'up';
  if (!COMMANDS.includes(command)) {
    throw new Error(`comando desconhecido: use ${COMMANDS.join(', ')}`);
  }
  if (!url) {
    throw new Error('DATABASE_URL ausente');
  }
  const orm = await MikroORM.init(ormConfig(url, DEFAULT_DATABASE_POOL_MAX));
  try {
    console.log(JSON.stringify(await run(orm, command as Command)));
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
