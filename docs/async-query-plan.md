# Acompanhamento assíncrono Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gerar PDFs de CPF/CNPJ quando uma consulta Deskdata demorar, sem duplicar POST.
**Architecture:** Manter um único índice local cifrado por conta, um monitor no processo principal e eventos IPC tipados para atualização do renderer. Sem servidor adicional.
**Tech Stack:** Electron, TypeScript, Node Test.
**Spec:** `docs/async-query-spec.md`

## Global Constraints
- Não modificar o módulo PIS, nem os modelos de PDF.
- Não chamar endpoints reais em testes.
- Reaproveitar códigos Q-XXXXXXXXXX; nunca automatizar novos POSTs para consultas incertas.

## Review Focus
- Código ausente após POST 202 não é recuperável automaticamente.
- Resposta GET de outro CPF/CNPJ deve ser recusada sem gerar PDF.
- Logout durante GET não deve gerar arquivo ou reassociar registro.
- Reinício com registros pendentes deve retomar apenas após autenticação.
- Falhas de rede devem pausar depois de tentativas limitadas.

### Task 1 — Cliente Deskdata
Files: `src/main/deskdata-client.ts`, `tests/async-client.test.mjs`.
Interfaces: `submitCpf`, `submitCompany`, `checkByCode`.
- [ ] Escrever testes que verifiquem 202 imediato e GET único; executar e confirmar falha.
- [ ] Implementar e rodar os testes até aprovação.

### Task 2 — Monitor e histórico
Files: `src/main/pending-queries.ts`, `src/main/query-history.ts`, `tests/pending-monitor.test.mjs`.
Interfaces: `PendingQueryMonitor.watch`, `.stopAll`, `QueryHistoryStore.setPending`, `.setPaused`.
- [ ] Escrever casos para polling, ausência de duplicação, timeout, logout; executar e confirmar falha.
- [ ] Implementar monitor e persistência; executar todos os testes.

### Task 3 — Fluxos Electron/UI
Files: `src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/renderer/main.tsx`, `src/renderer/styles.css`.
Interfaces: `QueryExecution` (estado `pending`/`ready`), `subscribeQueryUpdates`.
- [ ] Alterar CPF e CNPJ para retornar pendente ou PDF, retomar a partir do histórico e notificar a interface.
- [ ] Executar lint/test/typecheck/build quando disponível; revisar diff e empacotar.
