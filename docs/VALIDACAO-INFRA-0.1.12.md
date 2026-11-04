# Verificações locais da v0.1.12

- Base de código: DESKDATA_Projeto_DEV_0.1.11.zip.
- Comando: `node --experimental-strip-types --test tests/*.test.mjs`.
- Resultado observado: **89 testes / 89 aprovados / 0 falhas** em ambiente Node.js 22.16.0, com a API `node:sqlite` experimental nessa versão local.
- Migração testada: `queries.bin` cifrado → `queries.sqlite` com a mesma identificação, sem exclusão do arquivo anterior.
- Proteção testada: banco removido ou chave DPAPI ausente bloqueiam novas consultas.
- Escalabilidade funcional testada: registro de mais de 1.000 consultas e recuperação por índices HMAC.
- Backup ZIP: testado com uma consulta fictícia; abertura e CRC verificados com `zipfile` do Python.
- Logs: teste de exclusão de identificadores e dados sensíveis nos campos enviados para o logger.
- Typecheck: **não executado com sucesso**; faltam `@types/node` e `vite/client` neste ambiente.
- Build Electron/NSIS e assinatura: **não executados**, por falta das dependências npm e certificado de assinatura do Windows.
- Integração real Deskdata: **não executada**, sem consumo de créditos.
- Verificação ponta a ponta no Windows 11: **pendente**.

Não liberar instalador para terceiros até cumprir os testes de homologação descritos em INFRAESTRUTURA-BACKUP-0.1.12.md.
