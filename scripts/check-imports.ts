import { Glob } from 'bun';

const IMPORT = /^import\s[^;]*?from\s+(['"])([^'"]+)\1;$/gm;

function problemsOf(source: string): string[] {
  const imports = [...source.matchAll(IMPORT)].map((match) => ({
    path: match[2],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const firstRelative = imports.findIndex(({ path }) => path.startsWith('.'));
  if (firstRelative === -1) {
    return [];
  }
  const relative = imports.slice(firstRelative);
  const problems: string[] = [];
  if (relative.some(({ path }) => !path.startsWith('.'))) {
    problems.push('import externo depois de import relativo');
  }
  const lastExternal = imports[firstRelative - 1];
  if (
    lastExternal &&
    source.slice(lastExternal.end, imports[firstRelative].start) !== '\n\n'
  ) {
    problems.push('falta uma linha em branco entre imports externos e relativos');
  }
  relative.forEach(({ path }, index) => {
    const previous = relative[index - 1]?.path;
    if (previous !== undefined && path < previous) {
      problems.push(`'${path}' deveria vir antes de '${previous}'`);
    }
  });
  return problems;
}

let total = 0;
for (const pattern of ['src/**/*.ts', 'tests/**/*.ts']) {
  for await (const file of new Glob(pattern).scan('.')) {
    for (const problem of problemsOf(await Bun.file(file).text())) {
      console.error(`${file}: ${problem}`);
      total += 1;
    }
  }
}
if (total > 0) {
  console.error(`${total} problema(s) na ordem dos imports`);
  process.exit(1);
}
