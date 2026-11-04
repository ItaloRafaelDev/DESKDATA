import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryHistoryStore } from '../src/main/query-history.ts';

const protector = {
  isAvailable: async () => true,
  encrypt: async value => Buffer.from(value, 'utf8'),
  decrypt: async value => ({ result: value.toString('utf8'), shouldReEncrypt: false })
};

test('encerramento explícito libera SQLite, é idempotente e impede reabertura acidental', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deskdata-close-'));
  const store = new QueryHistoryStore(directory, protector);
  try {
    await store.begin('teste@example.org', '52998224725');
    await Promise.all([store.close(), store.close()]);
    await assert.rejects(store.list('teste@example.org'), /encerrado/i);
    assert.ok((await readdir(directory)).includes('queries.sqlite'));
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('encerramento aguarda gravações em andamento e preserva histórico ao reabrir', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deskdata-close-pending-'));
  const first = new QueryHistoryStore(directory, protector);
  const second = new QueryHistoryStore(directory, protector);
  try {
    const write = first.begin('teste@example.org', '52998224725');
    const closed = first.close();
    await write;
    await closed;
    assert.equal((await second.list('teste@example.org')).length, 1);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});
