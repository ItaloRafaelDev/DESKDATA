/** Lê uma resposta HTTP em partes, impedindo alocação ilimitada de corpo na memória. */
export async function readResponseLimited(
  response: Pick<Response,'body'|'headers'|'text'>,
  maxBytes: number
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Limite de resposta inválido.');
  const declared = response.headers?.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error('A resposta da API excede o limite de segurança.');
  }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // Compatibilidade com clientes e testes sem Web Streams; produção usa leitura incremental.
    const text = await response.text();
    if (Buffer.byteLength(text,'utf8') > maxBytes) throw new Error('A resposta da API excede o limite de segurança.');
    return text;
  }
  const reader = body.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(()=>{});
        throw new Error('A resposta da API excede o limite de segurança.');
      }
      parts.push(value);
    }
    return Buffer.concat(parts.map(part=>Buffer.from(part)),size).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}
