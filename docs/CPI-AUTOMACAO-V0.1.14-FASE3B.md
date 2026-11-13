# DESKDATA v0.1.14 — Fase 3B: identificação das linhas CPI (somente leitura)

## Base e evidências

- O usuário validou no Windows a Fase 3A: navegador Edge, filtro 29, espera periódica e contagem regressiva.
- O DOM do modal contém `id_tipo_pesq_29`; o filtro e a contagem foram verificados com lista **vazia**.
- Capturas anteriores mostram, em pesquisas existentes, colunas de **número de pesquisa**, **ID Solicit.** e **Tipo Pesquisa**; ainda não existe amostra real confirmada do DOM de uma linha de resultado.

## Contrato implementado

- Botão **Ler identificadores da listagem**, habilitado somente com Edge aberto e monitor pausado.
- Antes de ler, reaplica o filtro 29 e confirma o total do rodapé.
- Lê somente a página visível e retorna **dois IDs numéricos** (pesquisa/solicitação), com verificação da coluna **Tipo Pesquisa**.
- Não extrai nem exibe CPF, nomes, chaves, tokens, valores de formulário ou conteúdo do PDF.
- Se o total ou os cabeçalhos/IDs forem ambíguos, devolve `unconfirmed` ou `needs_mapping` e **nenhuma linha utilizável**.
- Se a página tiver mais de um lote, explicita que o restante ainda não foi percorrido.
- Não grava fila, não abre pesquisas, não consome créditos, não anexa arquivos e não salva alterações na CPI.

## Estados

- `empty`: total confirmado igual a zero.
- `mapped`: identificadores da página atual estruturados e numericamente consistentes, **ainda pendentes de validação em uma linha real no portal**.
- `needs_mapping`: listagem positiva, mas DOM incompatível ou dados ambíguos.
- `unconfirmed`: rodapé não confirmado.

## Testes e limitações

- Testes com DOM simulado cobrem tabela, ausência de linhas, seleção da modalidade, IDs inválidos, paginação e proteção contra leitura de campos pessoais.
- Nenhuma tela com registros reais foi observada neste ciclo, portanto **a extração dos IDs não está homologada no portal**.
- Fase futura: confirmar DOM de uma linha real, abrir solicitação em modo de leitura, validar CPF com identidade da CPI, e só então implementar fila persistente e integração de consulta.

## Política Git

- Atualização local incremental sobre a Fase 3A UI, branch `feature/cpi-automation`.
- Não executar commit nem push até autorização explícita do usuário.
