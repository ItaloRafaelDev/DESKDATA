import { historyTestScope } from './helpers/history-store.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskdataClient } from '../src/main/deskdata-client.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('company request sends only available datasets once',async()=>{
 const requests=[];
 const client=new DeskdataClient(async(url,opts)=>{requests.push({url,opts});if(url.endsWith('/auth'))return new Response(JSON.stringify({status:{code:2000},data:{access_token:'token',expires_at:'2099-01-01T00:00:00Z'}}),{status:200});return new Response(JSON.stringify({status:{code:4000},query_code:'Q-1234567890',data:{basic:{tax_id:{number:'11222333000181'}},phones:{items:[]},addresses:{items:[]},emails:{items:[]},relationships:{items:[]},lawsuits:{items:[]}}}),{status:200});});
 await client.authenticate('demo@example.com','password');await client.queryCompany('11222333000181');
 const q=requests.find(r=>r.url.endsWith('/queries'));const body=JSON.parse(q.opts.body);
 assert.deepEqual(body,{type:'companies',key_type:'cnpj',key_value:'11222333000181',datasets:['basic','phones','addresses','emails','relationships','lawsuits']});
 assert.equal(requests.filter(r=>r.url.endsWith('/queries')).length,1);
});
test('encrypted company history is separate from CPF, works across restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-co-'));const scope=historyTestScope();const protection={isAvailable:async()=>true,encrypt:async s=>Buffer.from(s),decrypt:async b=>({result:b.toString()})};
 try{const store=scope.open(dir,protection);const c=await store.beginCompany('example@company.com','11222333000181');await store.setCode(c.id,'Q-1234567890');assert.equal((await store.list('example@company.com','person')).length,0);assert.equal((await scope.open(dir,protection).list('example@company.com','company')).length,1);}finally{await scope.closeAll();await rm(dir,{recursive:true,force:true});}
});
