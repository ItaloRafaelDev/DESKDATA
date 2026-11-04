import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRecoveredCpf } from '../src/shared/query-identity.ts';
test('confirma CPF presente no JSON antes de associar código recuperado ao CPF',()=>{
 const payload={status:{code:4000},data:{basic:{tax_id:{number:'529.982.247-25'}}}};
 assert.doesNotThrow(()=>assertRecoveredCpf(payload,'52998224725'));
 assert.throws(()=>assertRecoveredCpf(payload,'12345678909'),/não corresponde/i);
 assert.throws(()=>assertRecoveredCpf({data:{basic:{}}},'52998224725'),/não foi possível confirmar/i);
});
