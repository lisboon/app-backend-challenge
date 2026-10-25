import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, '../../../scripts/check-imports.ts');
const quotes = [
  ["'", "'"],
  ['"', '"'],
  ["'", '"'],
  ['"', "'"],
] as const;

describe('verificador de imports', () => {
  let directory: string;
  let fixture: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'check-imports-'));
    mkdirSync(join(directory, 'src'));
    fixture = join(directory, 'src/fixture.ts');
    writeFileSync(fixture, '');
  });
  afterEach(() => {
    unlinkSync(fixture);
    rmdirSync(join(directory, 'src'));
    rmdirSync(directory);
  });

  const check = (source: string) => {
    writeFileSync(fixture, source);
    const result = Bun.spawnSync([process.execPath, script], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { status: result.exitCode, errors: result.stderr.toString() };
  };

  it.each(quotes)(
    'aceita relativos ordenados com delimitadores %s e %s',
    (first, second) => {
      expect(
        check(
          `import { a } from ${first}./a${first};\nimport { z } from ${second}./z${second};\n`,
        ),
      ).toEqual({ status: 0, errors: '' });
    },
  );

  it.each(quotes)(
    'recusa relativos invertidos com delimitadores %s e %s',
    (first, second) => {
      const result = check(
        `import { z } from ${first}./z${first};\nimport { a } from ${second}./a${second};\n`,
      );
      expect(result.status).toBe(1);
      expect(result.errors).toContain("'./a' deveria vir antes de './z'");
    },
  );

  it.each(["'", '"'])(
    'recusa externo depois de relativo com delimitador %s',
    (quote) => {
      const result = check(
        `import { a } from ${quote}./a${quote};\nimport { external } from ${quote}external${quote};\n`,
      );
      expect(result.status).toBe(1);
      expect(result.errors).toContain(
        'import externo depois de import relativo',
      );
    },
  );

  it.each(["'", '"'])(
    'recusa blocos sem linha em branco com delimitador %s',
    (quote) => {
      const result = check(
        `import { external } from ${quote}external${quote};\nimport { a } from ${quote}./a${quote};\n`,
      );
      expect(result.status).toBe(1);
      expect(result.errors).toContain('falta uma linha em branco');
    },
  );
});
