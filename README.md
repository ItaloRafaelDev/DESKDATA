## DESKDATA v0.1.13 — Correção do bloqueio SQLite (Windows EBUSY)

A versão v0.1.12 abria conexões `DatabaseSync` que permaneciam vivas após o fim dos testes. No Windows, `rm()` não pode excluir o arquivo SQLite ainda aberto, resultando em `EBUSY: resource busy or locked` em testes de PIS, CNPJ, histórico, manutenção, migração e backup.

**Correções:** `QueryHistoryStore.close()` idempotente aguarda operações aceitas, fecha a conexão, limpa a chave em memória e bloqueia novos acessos; testes encerram **todas** as instâncias antes de remover pastas temporárias; o Electron fecha o banco no evento `before-quit`, após aguardar conclusões já iniciadas. O arquivo `queries.sqlite`, a chave cifrada e os registros não são alterados pela atualização. Foram adicionados testes de regressão e um teste de integração estática do encerramento.

**Validação local:** `npm test` — 92/92 aprovados no Node 22.16.0 (Linux). `node --experimental-strip-types --check` passou nos dois módulos TS alterados. `npm run typecheck` não concluiu por ausência de `@types/node` e `vite/client` neste ambiente. Build e execução Windows pendentes. **A aprovação no Windows ainda precisa ser confirmada executando `npm test` no projeto atualizado.**

Detalhes: [`docs/CORRECAO-SQLITE-0.1.13.md`](docs/CORRECAO-SQLITE-0.1.13.md).

---

## DESKDATA v0.1.11 — Interface, notificações e preenchimento de acesso

Consulte [`docs/UI-LOGIN-NOTIFICATIONS-0.1.11.md`](docs/UI-LOGIN-NOTIFICATIONS-0.1.11.md). Atualização somente da interface React, sem alteração de endpoints ou de consumo de créditos.

---

## Atualização 0.1.9 — correção do relatório CNPJ

## Ajuste v0.1.10 — Consulta PIS sem número retornado

Quando a Deskdata retorna `200 / 4000` e `data.basic` é válido, mas `social_security.number` está ausente, nulo ou vazio, **nenhum PDF é gerado**. O histórico cifrado armazena `pis_unavailable`, conserva o código disponível e apresenta **PIS não informado** ao usuário. Uma nova tentativa pelo formulário reutiliza o resultado registrado, sem `POST` adicional. O botão **Verificar novamente via GET** permite consultar novamente o código existente, sem criar outra consulta. Se o número voltar a estar disponível, um PDF pode ser gerado no mesmo registro.

A ausência do campo na resposta não prova que a pessoa não possui PIS/NIS/NIT. CPF divergente, falha de dataset e número recebido em formato inválido permanecem como erros técnicos. Não há chamadas pagas nos testes automatizados.

Detalhes: `docs/CORRECAO-PIS-0.1.10.md`.

---

Corrige a impressão de `[object Object]` em campos estruturados da consulta CNPJ, com tratamento de razão social, inscrição estadual, natureza jurídica e variações de atividades econômicas. Consulte `docs/CORRECAO-CNPJ-0.1.9.md`. Não modifica a consulta à API nem gera novo consumo de créditos.

## Endurecimento v0.1.8 (sem novas dependências)

- Autorização de POSTs **por conta autenticada**, cifrada no Windows; a autorização global anterior não é herdada.
- Troca de sessão bloqueada durante operação em andamento; o monitor GET é interrompido e conclusões existentes são aguardadas antes da troca.
- Recebimento HTTP agora respeita o limite de 8 MB **durante** a leitura do stream, sem truncamento silencioso.
- Novos testes de isolamento de contas e respostas HTTP grandes.
- Consulte `docs/ENDURECIMENTO-ARQUITETURA-0.1.8.md` para riscos restantes, limites e plano de homologação.

> Depois de atualizar, **autorize novamente o consumo de créditos em Minha conta para cada login**. Isso é intencional e evita herdar uma permissão de outra conta.

# DESKDATA Desktop — DEV v0.1.7

## Acesso exclusivo por login

- Ao abrir o aplicativo, somente a página de autenticação aparece. As telas de consulta CPF, PIS, CNPJ e Configurações são renderizadas apenas após autenticação bem-sucedida.
- O menu **Minha conta** concentra a situação da sessão, saldo de créditos, autorização de consultas pagas e encerramento da sessão. Autorização anterior permanece conforme `settings.json` até revogação; não ocorre consumo de créditos apenas por acessar essa tela.
- O menu **Configurações** contém apenas a pasta de saída dos relatórios e a manutenção de dados locais, com lista de opções em área rolável.

## Limpeza segura com confirmação

- Opção **Excluir PDFs gerados** remove apenas arquivos PDF registrados no histórico cifrado e com nomenclatura de arquivo reconhecida como produzida pelo DESKDATA. PDFs desconhecidos, mesmo na pasta de saída, não são apagados.
- Opção **Excluir histórico de todas as consultas** elimina os registros locais de todas as contas desta instalação, inclusive IDs, estados e códigos `Q-...`; **não** apaga resultados na plataforma Deskdata. Sem esses códigos poderá ser impossível recuperar consultas anteriores sem novo consumo de créditos.
- As opções são independentes; ao escolher só histórico, os PDFs permanecem no disco, mas deixam de estar vinculados ao aplicativo. A confirmação nativa do Electron informa as quantidades e exige decisão explícita de excluir.
- Credenciais lembradas (`credentials.bin`) e `settings.json` **não** são apagados. A aplicação atual não cria arquivos separados de log de execução: os registros que mantém são os metadados cifrados de consultas em `queries.bin`. Logs da sessão do terminal ou de outros programas não são afetados.
- Se a exclusão de PDFs encontrar arquivo irregular ou falha, a operação para e mantém os registros dos PDFs não excluídos. Consultas em recuperação são interrompidas durante a limpeza e retomadas depois se o histórico não for apagado.

## Verificação no Windows 11

```powershell
Set-Location 'I:\DEV\DESKDATA'
npm test
npm run typecheck
npm run build
npm run dev
```

**Validação recomendada:** iniciar com login; testar o menu Minha conta e a alteração de autorização; verificar a pasta de destino e a prévia de limpeza. Para testar exclusão de PDFs, utilizar arquivos de teste criados pelo aplicativo. **Não acionar a limpeza em documentos reais sem backup e confirmação.**

A suíte local testa a limpeza com arquivos temporários, sem consultas reais nem consumo de créditos. Build e interface Electron devem ser validados no Windows do projeto.

---

# DESKDATA Desktop — DEV v0.1.6

## Acompanhamento automático em Consultar pessoa e Consultar CNPJ

- HTTP `202` com `status.code=4008` deixa a consulta **Em processamento**, sem manter o botão ocupado por vários minutos.
- O `POST /queries` é enviado uma única vez por consulta nova. O código Q-XXXXXXXXXX é persistido cifrado antes do acompanhamento.
- Um monitor no processo principal consulta somente `GET /queries/{query_code}` em intervalos crescentes (8, 12, 20, 30, 45, 60, até 90 segundos). No máximo duas verificações simultâneas; até 40 verificações por registro.
- Quando o resultado chega, a aplicação valida a identidade CPF/CNPJ, gera o PDF correspondente e atualiza o histórico automaticamente. Cada arquivo conserva seu botão **Abrir PDF**.
- Ao reabrir o aplicativo, as operações pendentes são retomadas **após autenticação na mesma conta**. O monitor não funciona com o aplicativo fechado.
- Se a API continuar processando após o limite ou houver falhas repetidas, o status vira **Recuperação pausada**. O botão **Retomar GET** permite continuar sem abrir nova consulta.
- Erros sem código recuperável permanecem **Pendente de verificação**; não se tenta um novo POST automaticamente.
- A interface recebe notificações do processo principal por IPC e atualiza a lista; PDFs existentes e módulo Consultar PIS não foram alterados.

A operação `GET` não substitui um `POST` que não chegou a fornecer código e não lista todo o histórico externo. Esta atualização não inclui consulta real à API nem promete que consultas pendentes concluam em prazo fixo.

## Verificação no Windows

```powershell
Set-Location 'I:\DEV\DESKDATA'
npm test
npm run typecheck
npm run build
npm run dev
```

Teste inicialmente uma consulta **já pendente com código conhecido** e confira as mudanças de status sem enviar novo `POST`. A execução real do Electron e a impressão de PDFs ainda dependem de validação no Windows.

---

# DESKDATA Desktop — DEV v0.1.5

Novo módulo **Consultar CNPJ** abaixo de Consultar PIS, mantendo o fluxo das versões anteriores.

A integração envia `type=companies`, `key_type=cnpj` com seis datasets disponíveis (`basic`, `phones`, `addresses`, `emails`, `relationships`, `lawsuits`) e gera o relatório empresarial A4. A Deskdata indica `relationships_phones` como indisponível no momento; não fazemos chamada para esse dataset. O histórico CNPJ tem rolagem independente, código de recuperação e botão individual Abrir PDF.

Documentação de escopo, testes, segurança e limitações: [`docs/CONSULTAR-CNPJ.md`](docs/CONSULTAR-CNPJ.md).

## Executar no Windows

```powershell
Set-Location 'I:\DEV\DESKDATA'
npm test
npm run typecheck
npm run build
npm run dev
```

Os PDFs e a configuração não são apagados na atualização incremental. Nenhuma API real foi consultada durante o desenvolvimento desta versão.

---

# DESKDATA Desktop — DEV 0.1.4

## Consulta PIS (nova, independente)

O menu **Consultar PIS** foi acrescentado abaixo de **Consultar pessoa**. A consulta de pessoas existente e seu PDF não foram alterados.

- Entrada: CPF válido. Autenticação JWT e configuração da pasta são compartilhadas.
- API: `POST /queries` com `{ "type":"persons", "key_type":"cpf", "key_value":"<CPF>", "datasets":["basic"] }`.
- A recuperação de consultas pendentes ou já registradas emprega `GET /queries/{query_code}` quando houver código válido; não é um segundo dataset.
- O campo que alimenta o rótulo **PIS** é `data.basic.social_security.number`, conforme observado na versão anterior. **A distinção oficial entre PIS, NIS e NIT requer confirmação adicional do fornecedor.** Se ausente, nenhum documento PIS será emitido.
- Campos do PDF: Nome, Gênero, Nascimento, Idade, CPF, Situação do CPF, Região fiscal, Data de registro do CPF e PIS.
- O relatório é compacto, A4, pt-BR e não informa fornecedor, origem de dados ou número do modelo.
- PDF: `PIS_<CPF>_<AAAA-MM-DD>.pdf` no destino configurado, com sufixo incremental se o nome existir.
- Histórico de PIS separado do histórico de consultas completas, com um botão **Abrir PDF** por arquivo e rolagem independente.
- Históricos são cifrados no Windows; registros antigos sem propriedade `kind` são tratados como `person`.
- A consulta PIS jamais emite nova requisição paga quando há um registro PIS inconclusivo sem código. Ela pode reutilizar um código da consulta completa que inclua `basic`, sem refazer POST.

## Ambiente Windows 11

```powershell
Set-Location 'I:\DEV\DESKDATA'
npm test
npm run typecheck
npm run build
npm run dev
```

O primeiro build exige `npm install` conforme o ambiente local. A validação com a API real requer a autorização de uso de créditos do usuário.

## Testes

`npm test` executa testes Node (com dados fictícios). `npm run test:demo:pis` produz um HTML A4 fictício para inspeção manual, sem conectar à API.

## Integração

Consulte a documentação: https://docs.deskdata.com.br/reference/queries-persons-basic e https://docs.deskdata.com.br/reference/queries-results

---

# DESKDATA Desktop — DEV v0.1.10

Aplicativo Electron + React + TypeScript para consultas autorizadas por CPF, com os cinco datasets fixos `basic`, `phones`, `addresses`, `emails` e `lawsuits`, e emissão de relatório PDF executivo A4.

## Instalação / execução no Windows 11

Use Node.js compatível com Electron/Vite, com o código em `I:\DEV\DESKDATA`.

```powershell
Set-Location 'I:\DEV\DESKDATA'
npm test
npm run typecheck
npm run build
npm run dev
```

Não é necessário instalar novas bibliotecas para atualizar da versão 0.1.2 à 0.1.3.

## Funcionalidade

1. Configure a pasta de PDFs e autorize consultas novas que consomem créditos.
2. Entre com suas credenciais autorizadas (armazenamento de senha só com consentimento, via proteção do Windows).
3. Informe o CPF. Se houver arquivo desse CPF no índice da mesma conta, o aplicativo reutiliza o PDF local; se não houver arquivo, mas houver código, usa **GET /queries/{query_code}** para recuperar e gerar novo PDF; caso não exista histórico, usa **POST /queries** apenas com autorização de créditos.
4. Se um código `Q-XXXXXXXXXX` estiver disponível de uma consulta feita anteriormente, expanda **Recuperar consulta pelo código Q-...** e informe o CPF e o código. A aplicação valida a correspondência do CPF antes de vincular o resultado. Não inicia novo `POST`.
5. Em **Resultado e histórico**, consulte uma lista rolável de operações e PDFs. Cada PDF tem seu próprio botão **Abrir PDF**. Quando a consulta contém um código, há também **Regerar PDF via GET**, sem sobrescrever o anterior.

## O que persiste

O índice `queries.bin`, gravado em `app.getPath('userData')`, é cifrado com `safeStorage` do Electron e separado logicamente por conta autenticada. Armazena somente CPF, data/hora, status da solicitação, código de consulta e caminhos dos PDFs. **Não armazena a resposta JSON completa**. Os próprios PDFs continuam na pasta escolhida e devem ser protegidos pelas permissões do Windows.

- O código é extraído de `query_code` ou `query.code`, quando a API retorna algum deles.
- O endpoint `GET /queries/{query_code}` exige um código conhecido; **não foi identificada na documentação pública uma rota para listar todas as consultas passadas por CPF**.
- Consultas antigas da versão 0.1.2 não são importadas automaticamente. PDFs já salvos continuam nas respectivas pastas, mas não aparecem automaticamente no novo índice.
- Se uma operação falhou após envio e não foi recebido código, o índice marca a operação como incerta e não repete o `POST` automaticamente. Não presuma que não houve consumo de créditos.
- A documentação não afirma que todas as consultas `GET` são isentas de limitações operacionais ou custos; a garantia técnica nesta implementação é que **não criamos um novo `POST /queries` na recuperação**.

## Relatório ao cliente

Apenas a **Competência** (`court_type` e, como alternativas de integração, `competence`/`competencia`) com valor `Criminal` aciona o destaque vermelho. O campo `sphere` não controla mais essa apresentação.

O PDF não inclui identificação da plataforma de origem, frase de fonte nem etiqueta "Modelo 01". O nome de arquivo para relatórios novos utiliza `RELATORIO_<CPF>_<DATA>.pdf`. A origem e os códigos continuam registrados internamente para rastreabilidade; não altere a interpretação jurídica das informações nem presuma culpa.

## Testes e limitações

`npm test` executa testes locais sem consulta à API e sem gasto de créditos. `npm run test:demo` gera uma prévia HTML sintética em `examples/modelo-01-demonstracao.html`. Nenhum CPF real é necessário.

A validação de TypeScript, o build Electron, o armazenamento cifrado real no Windows, o histórico e a emissão nativa do PDF ainda precisam ser verificados na instalação Windows atualizada. A produção do PDF de demonstração fora do Electron não comprova a compatibilidade da impressão nativa.

Documentação oficial: https://docs.deskdata.com.br/reference/queries-results e https://docs.deskdata.com.br/reference/orientacoes-basicas

## v0.1.12 — Persistência, diagnóstico, backups e distribuição

- Histórico de consultas em `queries.sqlite` (SQLite transacional, índices por conta protegidos com HMAC); o conteúdo de cada registro permanece cifrado pelo `safeStorage` do Windows.
- Na primeira execução, a migração lê o `queries.bin` anterior e importa os registros em uma transação. O arquivo legado **não é excluído**. Após a migração, o SQLite passa a ser a fonte de dados.
- A pasta de dados permanece `%APPDATA%\deskdata-desktop` para evitar perda aparente de histórico entre DEV e instalador. A pasta `logs` contém eventos técnicos JSONL sem CPF, CNPJ, e-mail, senha, token, respostas da API ou conteúdo judicial.
- **Configurações → Criar backup ZIP**: inclui cópia consistente `history.sqlite`, `history-key.bin`, `history-state.flag`, `credit-approvals.bin` (quando existente), `settings.bin` cifrado e `manifest.json` com hashes SHA-256. Não inclui PDFs, credenciais, respostas da API nem logs.
- A pasta de backup é `I:\DEV\DESKDATA\backups` quando o projeto for iniciado no diretório de desenvolvimento indicado, e `%APPDATA%\deskdata-desktop\backups` no aplicativo instalado. O ZIP usa proteção DPAPI por meio dos arquivos cifrados; só poderá ser restaurado com as mesmas chaves Windows. Ainda não existe importador/restaurador automático.
- **Configurações → Abrir pasta de backups** e **Abrir logs de diagnóstico**.
- Preparação de distribuição Windows x64 NSIS: `npm install`, `npm run dist:win`. O comando exige certificado de assinatura de código válido. A saída será `release/` quando o processo concluir. Não disponibilizar um executável não assinado como distribuição de produção.
- Na primeira migração, mantenha um backup externo de `%APPDATA%\deskdata-desktop` (especialmente `queries.bin`, autorizações e arquivos existentes) para permitir recuperação em caso de falha.

### Critérios de homologação Windows pendentes

1. `npm install`, `npm test`, `npm run typecheck`, `npm run build`.
2. Inicializar com o histórico antigo e conferir a quantidade de CPF/PIS/CNPJ e seus códigos recuperáveis.
3. Criar backup, abrir pasta e validar o ZIP sem compartilhar seus dados reais.
4. Verificar o histórico ao reiniciar, criar PDFs e recuperar por GET sem repetição do POST.
5. Verificar logs (sem identificadores pessoais), instalar o NSIS assinado em VM e validar desinstalação/reinstalação sem perder `%APPDATA%`.
