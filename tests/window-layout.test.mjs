import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('janela Electron oculta a barra de menus antiga, preservando a tecla Alt',async()=>{
  const main=await readFile(new URL('../src/main/index.ts',import.meta.url),'utf8');
  assert.match(main,/autoHideMenuBar\s*:\s*true/);
});
