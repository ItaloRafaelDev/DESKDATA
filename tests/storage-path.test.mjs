import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
test('userData path é criado antes de setPath, mantendo histórico DEV nas instalações',async()=>{
 const code=await readFile(new URL('../src/main/index.ts',import.meta.url),'utf8');
 assert.match(code,/mkdirSync\(stableDataDirectory,\{recursive:true\}\)/);
 assert.ok(code.indexOf('mkdirSync(stableDataDirectory')<code.indexOf("app.setPath('userData',stableDataDirectory)"));
});
