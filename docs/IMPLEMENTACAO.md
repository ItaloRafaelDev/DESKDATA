# DESKDATA - plano de implementação (30/10/2026)

**Objetivo:** aplicativo desktop para consulta autorizada por CPF, cinco datasets fixos (`basic`, `phones`, `addresses`, `emails`, `lawsuits`), geração automática de relatório A4 Modelo 01 com marcação vermelha para esfera Criminal e gravação local.

**Arquitetura:** Electron main process concentra rede, token, proteção criptográfica e filesystem. React renderer só recebe credenciais quando a pessoa clica em “Preencher dados salvos” e usa IPC por preload isolado. `src/shared` define validação de CPF, normalização dos retornos e HTML do relatório.

**Referências oficiais:**
- https://docs.deskdata.com.br/reference/auth
- https://docs.deskdata.com.br/reference/credits
- https://docs.deskdata.com.br/reference/orientacoes-basicas
- https://docs.deskdata.com.br/reference/queries-results
- https://docs.deskdata.com.br/reference/queries-persons-lawsuits
- https://www.electronjs.org/docs/latest/tutorial/security

## Ciclos de entrega e verificação

- [x] Descrever critérios de entrada, saída e limites de consumo.
- [x] Validar CPF e mascaramento; teste `tests/cpf.test.mjs`.
- [x] Normalizar envelope `data.*` e impedir PDF com dataset ausente/erro; teste `tests/normalizer.test.mjs`.
- [x] Produzir HTML A4 do Modelo 01 com todas as partes/processos e marcação vermelha `criminal`; teste `tests/report.test.mjs`.
- [x] Implementar (sem validação de build Electron) Electron isolado com preload e permissões de IPC restritas.
- [x] Implementar (sem chamada real) autenticação Deskdata, créditos, POST /queries e recuperação GET /queries/{query_code}.
- [x] Implementar (sem teste de I/O no Windows) escolha de pasta, exportação PDF sem sobrescrita e salvamento sem nova consulta.
- [ ] Validar build Linux/offline (se dependências indisponíveis, reportar condição).
- [ ] Validar app no Windows 11 e API real, com credenciais somente na máquina autorizada.
- [ ] Validar relatório usando JSON real mascarado (nomes de chaves/contrato variáveis).

## Testes de risco

1. CPF com dígito verificador incorreto -> operação bloqueada antes de autenticação/consumo.
2. Dataset ausente ou com falha -> PDF não produzido com aparente completude.
3. Processo com `sphere: 'Criminal'` -> bloco vermelho; `Civil` -> neutro.
4. Conteúdo JSON com HTML malicioso -> texto escapado; sem execução na prévia/PDF.
5. Erro de gravação -> preservar resultado na memória para reexportar sem refazer consulta.
6. Retorno 202 -> reutilizar `query_code`, sem novo POST, tempo de polling limitado.
7. Perda do retorno de POST após transmissão -> não repetir automaticamente para evitar cobrança duplicada.

## Restrições

Não executar consulta real sem autenticação/consentimento. Não persistir resposta bruta, senha ou token no disco. Não registrar CPF ou dados pessoais em logs. Não assumir culpa em matéria processual. A classificação Criminal é apenas indicador da esfera.

## Verificações locais executadas
- `npm test`: 12 testes aprovados, nenhum acesso externo.
- `npm run test:demo`: geração HTML com dados sintéticos.
- `weasyprint` (Python): PDF ilustrativo A4, 3 páginas, renderizado e inspecionado. Esse mecanismo não substitui o teste de `webContents.printToPDF` no Electron.
- Compilação da GUI Electron e consulta real: NÃO executadas, dependências npm indisponíveis nesta sessão.

## Revisão 0.1.2

- [x] Mapear dados básicos aninhados, campos relevantes e enums ingleses para pt-BR em layout Modelo 01.
- [x] Prévia sintética A4 gerada e inspecionada via WeasyPrint (2 páginas).
- [x] Implementar e testar cofre local cifrado com abstração para `safeStorage`.
- [x] Adicionar operações IPC protegidas para lembrar/recuperar/apagar e abrir último PDF.
- [x] Testes de domínio: 25 aprovados em Node.js 22.16.
- [ ] Instalar dependências e executar `npm run typecheck` e `npm run build` (indisponíveis nesta sessão).
- [ ] Homologar no Windows: DPAPI, impressão PDF via Electron, paginação longa, sem consumo duplicado.
- [ ] Validar chaves de esfera em JSON real sem armazenar/compartilhar dados pessoais.
