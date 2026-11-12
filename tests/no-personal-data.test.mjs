import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidCpf } from '../src/shared/cpf.ts';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const ALLOWLIST=new Set(['52998224725','11144477735','12345678909','98765432100']);
const IGNORED=new Set(['package-lock.json']);
const BINARY=/\.(?:png|jpe?g|gif|ico|icns|bmp|webp|pdf|zip|gz|7z|exe|dll|node|woff2?|ttf|otf|eot|db|sqlite|bin|pfx|p12)$/i;
// 11 dígitos, com ou sem pontuação (000.000.000-00), sem fazer parte de um número maior.
const CPF_LIKE=/(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\d])/g;

const mask=digits=>`${digits.slice(0,3)}******${digits.slice(-2)}`;

test('nenhum arquivo versionado contém CPF válido fora da allowlist',()=>{
 const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean);
 assert.ok(files.length>0,'git ls-files não retornou arquivos.');
 const findings=[];
 for(const file of files){
  if(IGNORED.has(file.split('/').pop())||BINARY.test(file))continue;
  let buffer;
  try{buffer=readFileSync(join(root,file));}catch{continue;}
  if(buffer.subarray(0,8000).includes(0))continue;
  buffer.toString('utf8').split(/\r?\n/).forEach((line,index)=>{
   for(const match of line.matchAll(CPF_LIKE)){
    const digits=match[0].replace(/\D/g,'');
    if(isValidCpf(digits)&&!ALLOWLIST.has(digits))findings.push(`${file}:${index+1} → CPF ${mask(digits)}`);
   }
  });
 }
 assert.deepEqual(findings,[],`CPF válido encontrado em arquivo versionado (use um CPF da allowlist):\n${findings.join('\n')}`);
});

test('máscara nunca expõe o CPF completo',()=>{
 assert.equal(mask('52998224725'),'529******25');
});
