import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Electron finaliza consultas ativas e fecha SQLite antes de sair', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(source, /app\.on\('before-quit'/);
  assert.match(source, /await\s+history\?\.close\(\)/);
  assert.match(source, /await\s+Promise\.allSettled\(\[\.\.\.activeCompletions\]\)/);
});
