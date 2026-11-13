# CPI — integridade judicial (Etapa 4)

Base: `9ea79a2282f8885ef4a54163f5cc8cbc3fd79aa5` (`origin/main` após incorporar
`9f1ee99f2a3758f3bd463524ab60f11e7828df88`). Branch: `feature/cpi-judicial-integrity`.

## Contrato consultado e limites

Referência oficial consultada em 11/11/2026:
[Processos de pessoas — Deskdata](https://docs.deskdata.com.br/reference/queries-persons-lawsuits).
Foi inspecionado o schema de resposta embutido na própria página pública, sem
usar Try It, credenciais ou o endpoint de consultas.

O retorno judicial é `data.lawsuits`; `items` é uma lista de objetos. O schema
descreve `total`, `total_as_author`, `total_as_defendant` e `total_as_other` como
inteiros. `court_type` é string, descrita como Tipo do tribunal, sem enumeração.
O schema não declara esses campos obrigatórios, nem documenta paginação, limite
de itens ou exclusividade dos papéis agregados. Não contém `competence` ou
`competencia`, nem estabelece equivalência entre esses nomes e `court_type`.

Consequentemente, não se exige total quando items existe, não se soma papéis e
não se inventa paginação. Esses limites não provam cobertura integral das bases
judiciais externas. A validação verifica a consistência do retorno recebido.

## Causas verificadas

- O normalizador aceitava total positivo com items vazio, total diferente da
  quantidade de itens, contadores inválidos e itens não objetos.
- A classificação tratava qualquer string não vazia diferente de Criminal como
  não criminal, inclusive valores desconhecidos ou placeholders.
- A seleção com `??` na CPI e a seleção de apresentação no PDF divergiam: uma
  string vazia ou com espaços podia esconder outro campo preenchido.
- O FULL AUTO classificava o GET atual, mas reutilizava PDF ready anterior sem
  prova de que ele continha os mesmos processos. Vínculo CPF/registro e assinatura
  PDF são necessários, mas não comprovam a versão do conteúdo.

## Regras implementadas

`judicial.ts` concentra a inspeção do dataset e a resolução de campos explícitos.
Normalização de pessoas, recuperação, CPI e normalização empresarial reutilizam
a mesma validação. Nenhum item é filtrado, reordenado ou deduplicado.

- Contadores presentes exigem inteiro seguro não negativo, sem coerção de string,
  null ou booleano. total deve coincidir exatamente com items.length. Cada contador
  de participação não pode exceder a quantidade de processos, mas papéis não são somados.
- items ausente só vira [] se total for o número zero, preservando a compatibilidade
  local anterior. items nulo/inválido ou item não objeto bloqueiam emissão e CPI.
- Dataset com erro não é tratado como ausência legítima de ocorrências.
- O vocabulário operacional existente reconhece Criminal, Civil/Cível, Trabalhista,
  Fazenda, Especial Cível e Tax. Essa lista é conservadora e não é um enum oficial.
  Acentos, caixa e espaços são normalizados; textos compostos não são interpretados.
- Só court_type conhecido autoriza a decisão automática. Criminal confirmado em
  lista íntegra gera restrições; lista íntegra exclusivamente não criminal ou vazia
  gera informações. Um único item não resolvido bloqueia a lista inteira para CPI.
- competence/competencia podem ser exibidos quando court_type estiver vazio, mas
  não são promovidos a fonte equivalente. Valores divergentes bloqueiam automação.
  Não se infere criminalidade por vara, assunto, tipo, esfera DOM ou participação.

O PDF mantém CSS/layout executivo, todos os processos e suas seções existentes.
Seu destaque criminal usa a mesma resolução da CPI. Informação alternativa sem
contrato comprovado permanece visível sem receber destaque de criminal confirmado.
Ausência legítima de campo opcional é distinta de ausência de processos: não é
erro estrutural do JSON, mas impede decisão automática se a categoria não é conhecida.

No FULL AUTO, um PDF novo é gerado do mesmo NormalizedData usado na classificação,
mesmo havendo PDF ready. Só referências novas adicionadas ao histórico nessa geração
podem ser anexadas; não há fallback para PDF legado se a geração/vinculação falhar.
Arquivos anteriores são preservados. Isso aumenta geração e armazenamento local,
sem nova consulta paga ou GET adicional. O writer existente cria nomes exclusivos.

## Diagnósticos e recuperação

`DataContractError.issue` e `assessCpiPerson().issues` retornam códigos, nome fixo
de campo e índice do item, nunca seu valor, CPF, número de processo ou payload.
Os casos distinguem missing/empty/invalid/unknown court_type, alias não comprovado,
conflito, contadores inválidos, divergência de total e itens inválidos.

O ciclo persiste `review_required` e o primeiro código `reviewReason`, validado
contra enum fechado, antes de gerar PDF ou enviar à CPI. A extensão é opcional,
sem migration, compatível com workflows anteriores. Após reinício, revisão continua
bloqueante. Não se relaxam submit_started, verification_required ou completed.
Não se libera automaticamente um workflow antigo já em revisão.

## Testes e pendências

Fixtures locais cobrem contadores, tipos inválidos, ausência/desconhecido, aliases,
processos mistos, ausência de ocorrências, conservação dos itens, PDF e classificação,
persistência do motivo de revisão, reinício e PDF legado com resposta atual diferente.
O teste de recuperação da Etapa 3 foi adaptado para a geração de outro PDF; conserva
as verificações de arquivo legado, classificação e ausência de repetição após reinício.

Não houve consulta paga, envio à CPI ou alteração de banco operacional. Permanecem
pendentes com o fornecedor a enumeração e semântica precisa de court_type, a eventual
equivalência de aliases e garantias de truncamento/cobertura externa. Sem confirmação,
valores fora do vocabulário ficam em revisão; não se promete eliminar todos os casos
unknown_competence. Homologação real e confirmação remota do PDF seguem pendentes.

## Resultados locais registrados

- TDD inicial: 62 testes judiciais, 48 falhas reproduzindo validações ausentes e
  classificações indevidas; após correção, todos passaram.
- Integração de revisão: cinco falhas reproduzidas antes da persistência dos motivos;
  após correção, passaram. O cenário de PDF legado também falhou antes da correção.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0; renderer e CSS não foram alterados.
- `npm test`, execução final: 329 testes, 329 aprovados, zero falhas/ignorados,
  exit 0 (258 casos anteriores e 71 novos).
- `git diff --check`: exit 0.
- Uma execução integral intermediária teve 327/328 aprovações e ENOTEMPTY na
  limpeza do caso preexistente “estado de envio permite finalização, mas não segundo
  envio” (`cpi-workflow-store.test.mjs`). Três execuções isoladas passaram sem mudar
  esse teste ou suas assertions; a integral final passou. A causa ambiental exata
  não foi comprovada, e não foi classificada como defeito de produção.

A revisão independente não identificou bloqueadores após a correção do PDF legado.
Não há scripts de lint/format configurados no package.json; nenhum foi instalado.
