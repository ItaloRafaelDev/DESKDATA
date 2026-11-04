import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRememberedLogin, notificationDuration } from '../src/renderer/ux.ts';

test('preenchimento automático consulta o cofre somente quando há credenciais salvas', async () => {
  let loads=0;
  const empty={credentialsStatus:async()=>({hasSaved:false}),loadSavedCredentials:async()=>{loads++;return null;}};
  assert.equal(await loadRememberedLogin(empty),null);
  assert.equal(loads,0);
  const stored={credentialsStatus:async()=>({hasSaved:true}),loadSavedCredentials:async()=>{loads++;return {email:'teste@example.org',password:'senha-de-teste'};}};
  assert.deepEqual(await loadRememberedLogin(stored),{email:'teste@example.org',password:'senha-de-teste'});
  assert.equal(loads,1);
});

test('preenchimento automático não inventa credenciais quando o arquivo foi removido',async()=>{
  assert.equal(await loadRememberedLogin({credentialsStatus:async()=>({hasSaved:true}),loadSavedCredentials:async()=>null}),null);
});

test('notificações temporárias mantêm erros visíveis por mais tempo',()=>{
  assert.ok(notificationDuration('error')>notificationDuration('success'));
  assert.ok(notificationDuration('info')>0);
  assert.ok(notificationDuration('success')>0);
});

test('erro de abertura do cofre é propagado sem fabricar uma senha',async()=>{
  const failure={credentialsStatus:async()=>({hasSaved:true}),loadSavedCredentials:async()=>{throw new Error('Proteção indisponível');}};
  await assert.rejects(loadRememberedLogin(failure),/Proteção indisponível/);
});
