# Integridade judicial — plano da Etapa 4

> Execução inline com a skill superpowers:executing-plans; sem commit ou publicação.

**Objetivo:** impedir decisões CPI e PDFs baseados em listas judiciais contraditórias,
sem inferir criminalidade nem descartar processos.

**Arquitetura:** módulo compartilhado `src/shared/judicial.ts` valida o dataset e
resolve exclusivamente campos judiciais explícitos. Os normalizadores de pessoas
e empresas reutilizam a validação; PDF e CPI reutilizam a resolução. Contratos
públicos permanecem; diagnósticos opcionais contêm apenas códigos e índices.

**Stack:** TypeScript, Electron e node:test existentes, sem dependências novas.

**Especificação:** solicitação Etapa 4 e documentação oficial de processos Deskdata.
O schema embutido na página oficial descreve court_type como Tipo do tribunal,
sem enumeração, e não documenta competence/competencia. Não há base para promover
esses aliases à fonte automática da decisão. A regra aprovada do projeto usa
court_type Criminal; valores não criminais reconhecidos mantêm a regra anterior.

## Restrições e decisões

- Sem chamadas pagas, CPI, bases operacionais, commit, push, merge ou deploy.
- Preservar correções das Etapas 1–3 e as 258 verificações existentes.
- total e contadores de participação são opcionais no schema. Se presentes,
  exigir inteiros seguros não negativos; total deve coincidir com items.
- Cada contador de participação não pode exceder o total de processos. Não somar
  categorias: o contrato não garante exclusividade de papéis por processo.
- items ausente só pode virar [] com total numérico zero, como no contrato local.
- Não tratar lista sem total como incompleta: o schema não exige esse campo nem
  documenta paginação. Isso não comprova cobertura de todas as bases externas.
- Ausência, vazio, tipo inválido, valor desconhecido e alias sem equivalência
  comprovada têm diagnósticos diferentes. Divergência entre campos explícitos
  bloqueia a automação. Nada de inferência por vara, assunto, tipo ou polo.
- Preservar dados originais e todos os itens. Não alterar CSS/layout executivo.
- Desconhecidos permanecem em revisão; não ampliar enum por aproximação textual.

## Tarefas

- [x] Criar testes em `tests/judicial-integrity.test.mjs`: contadores contraditórios,
  itens inválidos, valores judiciais, aliases, conservação dos itens e PDF.
- [x] Executar esses testes contra o baseline e registrar falhas reais.
- [x] Implementar `inspectJudicialDataset(value)` e
  `resolveJudicialCompetence(item)` em `src/shared/judicial.ts`.
- [x] Integrar `normalizer.ts`, `company-report.ts`, `report.ts` e `person-rules.ts`.
  Manter `classifyCpiPerson` e `isCriminalCompetence` como entradas compatíveis.
- [x] Integrar diagnósticos de revisão ao ciclo/workflow sem mudar envio,
  confirmação ou recuperação; persistir somente código de motivo.
- [x] Testar fronteiras de consulta/PDF e ciclo CPI com respostas simuladas:
  incompletas não geram PDF, não marcam ready e não chegam a submit_started.
- [x] Executar testes afetados, typecheck, suíte integral, build e diff --check.
- [x] Documentar contratos confirmados, limites e resultados reais.

Decisão adicional após revisão: o PDF ready legado não comprova correspondência
com o GET atual. O ciclo gera nova referência da resposta classificada e só permite
essa referência no anexo, preservando arquivos anteriores. Custo: geração e disco
adicionais, sem consulta extra. Teste reproduziu uso do legado antes da correção;
fixture de recuperação adaptada mantendo as verificações de preservação e reinício.

Evidência final: 329/329 testes, typecheck/build/diff --check aprovados. Uma limpeza
intermediária ENOTEMPTY no teste preexistente de workflow foi registrada; três runs
focados e a suíte final passaram sem alterar aquele teste.

## Foco de revisão

- Lista vazia contradizendo total positivo; total menor ou maior que items.
- Coerção indevida de contadores (string, null, booleano, fração, negativo).
- Criminal junto a processo ausente/desconhecido: não liberar envio parcial.
- court_type vazio e alias preenchido: mostrar a informação sem supor equivalência.
- PDF e classificação discordando sobre a fonte efetiva ou perdendo processos.
