# Login isolado e limpeza local — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Aplicação incremental e test-driven development.

**Goal:** Exigir login antes das consultas, mover a autorização de créditos à página Conta e criar manutenção local segura com rolagem e confirmação explícita.

**Architecture:** Preservar IPC existente; controlar navegação autenticada no React e autorização no processo principal. Serviço de manutenção com caminhos vinculados ao histórico cifrado e exclusão restrita a PDFs criados pelo aplicativo; não apagar arquivos não vinculados nem alterar registros remotos.

**Tech Stack:** Electron, React, TypeScript, Node.js; testes node:test.

**Spec:** Requisitos fornecidos pelo usuário nesta conversa, 30/10/2026.

## Global Constraints
- Não modificar lógica de consulta CPF, PIS, CNPJ nem endpoints da Deskdata.
- Preservar histórico e códigos quando somente PDFs forem apagados.
- Nenhuma exclusão automática, silenciosa ou fora do índice de arquivos gerados pelo aplicativo.
- Confirmação explícita nativa antes de apagar PDFs e/ou histórico de consultas.
- Configuração de pasta e credenciais salvas permanecem após a limpeza.

## Review Focus
- Documento PDF alheio na pasta de saída nunca deve ser removido.
- Links de PDFs antigos e códigos de recuperação devem manter integridade após limpeza seletiva.
- Histórico contém dados de mais de uma conta; a prévia deve descrever alcance global local.
- Consulta pendente deve ser interrompida na limpeza e não recriada por POST.
- Falha parcial na exclusão deve preservar metadados necessários para nova tentativa.

---

### Task 1 — Serviço de manutenção e testes
**Files:** `src/main/maintenance.ts`, `src/main/query-history.ts`, `tests/maintenance.test.mjs`.
- [ ] Teste RED: PDF registrado removido; arquivo externo preservado; códigos mantidos ao apagar somente PDFs.
- [ ] Teste RED: limpeza do índice local apenas quando autorizada e sem apagar configuração/credenciais.
- [ ] Teste RED: falhas de exclusão preservam histórico.
- [ ] Implementar a operação com resumo para confirmação, verificações de caminho e resultado estruturado.
- [ ] Rodar todos os testes.

### Task 2 — IPC e autorização
**Files:** `src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts`.
- [ ] Expor prévia/limpeza e confirmar no main process com `dialog.showMessageBox()`.
- [ ] Impedir limpeza concorrente, interromper monitor pendente, limpar cache local de sessão.
- [ ] Bloquear configurações protegidas sem autenticação.

### Task 3 — Interface
**Files:** `src/renderer/main.tsx`, `src/renderer/styles.css`.
- [ ] Tela exclusiva de login; após autenticação, apresentar Conta e créditos; consultas só após login.
- [ ] Configurações: somente pasta de saída e limpeza em seção de rolagem.
- [ ] Controles separados para apagar PDFs e histórico; prévia e confirmação nativa.
- [ ] Atualizar textos antigos da interface para indicar autorização em Conta e créditos.

### Task 4 — Verificação/empacotamento
**Files:** `README.md`, `package.json`, ZIP incremental e completo.
- [ ] Rodar testes, verificação sintática, typecheck/build quando disponíveis.
- [ ] Fazer revisão dos arquivos alterados e do ZIP; reportar pendências de execução real.
