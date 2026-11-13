# DESKDATA — Auditoria inicial e endurecimento v0.1.8

Data: 30/10/2026. Origem: código-fonte da versão 0.1.7 disponível nesta conversa; ambiente de execução local Linux com Node 22.16, **não** a instalação `I:\DEV` do usuário.

## Alterações implementadas nesta etapa

1. Autorização de consultas pagas deixa de ser global (`settings.json`) e passa a ser **por conta autenticada**, cifrada em `credit-approvals.bin` via `safeStorage`/DPAPI do Electron no Windows. O consentimento anterior **não é migrado**; deve ser concedido novamente para cada conta.
2. Para novos POST em Pessoa, PIS e CNPJ, a verificação de autorização ocorre no processo principal e usa a conta autenticada. Recuperação por GET e reutilização de PDF não necessitam de novo consentimento para POST.
3. Transições de sessão (login/logout) são bloqueadas durante consulta ou manutenção; recuperações automáticas são canceladas e conclusões já iniciadas terminam antes da mudança de conta. Falha após autenticação limpa o estado de sessão parcial.
4. A interface atualiza a autorização após autenticação e desmarca o consentimento ao sair; a pasta de destino permanece configurada.
5. O cliente HTTP agora lê respostas por stream limitado a 8 MB, interrompendo o recebimento quando ultrapassado, inclusive com cabeçalho `Content-Length` excessivo. A API não é consultada novamente em caso de limite excedido.

## Riscos confirmados e próximos incrementos

### Alto — Persistência de histórico e recuperação
- `src/main/query-history.ts` reescreve todo o índice cifrado, com máximo de 1.000 registros; não há migração versionada nem cópia de recuperação. Considerar SQLite com esquema versionado **após** testar migração reversível e estratégia de criptografia por campo ou arquivo.
- A ausência de código de retorno após falha de rede do POST deixa consulta `uncertain`. A preservação desse estado evita cobrança duplicada, mas requer diagnóstico e conciliação manual.
- Necessário teste de histórico real ao reiniciar Electron durante consulta pendente (sem novos POST).

### Alto — PDFs e dados extensos
- **Mitigado v0.1.8:** `src/main/deskdata-client.ts` carregava todo o corpo antes de verificar 8 MB. Agora usa `readResponseLimited()` com `ReadableStream` e limite em bytes. Validar resposta grande em execução real Electron; limite permanece 8 MB e continua impedindo PDFs de retornos maiores sem mecanismo adicional seguro.
- `src/main/pdf.ts` gera relatórios em janela Chromium sem timeout explícito de impressão. Há risco de travamento com relatórios muito extensos. Implementar timeout/cancelamento e validação em Electron com dados fictícios volumosos.

### Médio — Segurança e confiabilidade operacional
- Revisar CSP do renderer no modo de produção e política de permissão de janelas auxiliares, segundo recomendações oficiais do Electron.
- Tornar gravação de `settings.json` atômica e adicionar testes de recuperação de corrupção, sem apagar configurações de forma silenciosa.
- Histórico de metadados não substitui logs estruturados; adicionar diagnósticos com correlation id, tempo de resposta e categoria de falha, sem CPF, CNPJ, token ou payload pessoal.
- Auditoria de dependências, `package-lock.json`, empacotamento e instalação em Windows ainda pendentes.

## Verificações e limites

- `node --experimental-strip-types --test tests/*.test.mjs` executado no ambiente disponível (registrar resultado atual no relato da entrega).
- `tsc --noEmit -p tsconfig.json` não foi concluído neste ambiente: faltam `@types/node` e `vite/client` instalados. **Não interpretar como erro de código.**
- **Não** executadas chamadas reais à Deskdata, consultas pagas, instalador Windows ou testes de GUI Electron.

## Homologação Windows — antes de liberar consulta paga

1. Backup de `I:\DEV\DESKDATA` e de `%APPDATA%\deskdata-desktop` (localização efetiva de userData a confirmar no app Windows).
2. Instalar patch somente com Electron encerrado; `npm test`, `npm run typecheck`, `npm run build` e `npm run dev`.
3. Autenticar A, confirmar autorização inicial desmarcada; habilitar e verificar persistência após reinício. Encerrar sessão. Autenticar B, confirmar autorização inicial desmarcada; habilitar B não pode alterar A.
4. Com consultas já existentes, usar **somente GET/código** para testar histórico e gerar PDF. Não iniciar POST pago para provar a interface.
5. Testar logout bloqueado enquanto geração de relatório está ativa; testar restauração após falha e saída durante acompanhamento GET.

## Reversão

Restaurar o backup do código 0.1.7 e manter arquivo `credit-approvals.bin` intacto (0.1.7 ignora esse novo índice). Nunca excluir `queries.bin` nem PDFs para reverter a aplicação. A versão 0.1.7 mantém o consentimento global legado em `settings.json`; revogar explicitamente antes de executar consultas com contas alternativas.
