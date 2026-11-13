# Desktop consultation reliability implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax to track progress.

**Goal:** Evitar autorização cruzada entre contas, transições perigosas de sessão e evoluir a resiliência da geração PDF e do histórico.

**Architecture:** Preservar monólito modular Electron + React/TypeScript; APIs exclusivamente no main process e histórico local por conta. Implementar correções pequenas, testáveis e reversíveis.

**Tech Stack:** Electron, React, TypeScript, Node.js, testes Node test runner.

**Spec:** `docs/ENDURECIMENTO-ARQUITETURA-0.1.8.md`

## Global Constraints
- Sem POST real, consumo de créditos ou exclusões no Windows.
- Preservar Consultar pessoa, PIS, CNPJ, modelos PDF e histórico local existentes.
- Sem novas dependências para o patch de autorização.

## Review Focus
- Conta B nunca herda autorização de conta A.
- Índice de autorização corrompido nunca autoriza POST.
- Chamada login/logout não altera sessão durante consulta ativa.
- Reentrada após reinício não duplica consulta cobrada.
- Geração PDF grande não deixa processo preso nem dados truncados.

### Task 1 — Autorização por conta

**Files:** `src/main/account-approval.ts`, `src/main/index.ts`, `src/main/settings.ts`, `src/renderer/main.tsx`, `tests/account-approval.test.mjs`.

**Interfaces:** `isApproved(account):Promise<boolean>`, `setApproved(account,approved):Promise<void>`.

- [x] Escrever testes que verificam isolamento de contas, persistência cifrada, concorrência e corrupção.
- [x] Rodar testes e verificar falha pela ausência do módulo.
- [x] Implementar arquivo cifrado isolado por conta e integrar ao processo principal.
- [x] Rodar testes para confirmar aprovação e regressão.

### Task 2 — Transição de sessão

**Files:** `src/main/index.ts`, `src/renderer/main.tsx`.

- [x] Negar login/logout durante consulta, manutenção ou outra transição.
- [x] Cancelar monitor e aguardar finalizações em andamento antes de mudar conta.
- [x] Limpar estado parcialmente autenticado em caso de erro após login.
- [ ] Validar troca de conta e concorrência no Electron Windows com relatório extenso.

### Task 3 — Corpo HTTP limitado de verdade

**Files:** `src/main/deskdata-client.ts`, `tests/api.test.mjs`.

- [x] Escrever teste com stream acima de 8 MB e verificar falha segura sem consumir memória ilimitada.
- [x] Implementar leitura incremental limitada e cancelar reader no excesso.
- [x] Rodar suíte completa e verificar sem mudança de contratos (simulados).

### Task 4 — Persistência e relatório volumoso

**Files:** `src/main/query-history.ts`, `src/main/pdf.ts`, testes dedicados, documentação de migração.

- [ ] Especificar esquema com migração versionada e cópia de segurança segura para histórico.
- [ ] Testar migração, rollback, arquivos corrompidos e concorrência, sem perder códigos.
- [ ] Implementar timeout de impressão; testar relatório CNPJ extenso sem travar e sem truncar.

### Task 5 — Qualidade de distribuição

- [ ] Auditar dependências, criar lockfile validado e pipeline de typecheck/test/build.
- [ ] Validar compilação e instalador no Windows antes de preparar `.exe` para clientes.
