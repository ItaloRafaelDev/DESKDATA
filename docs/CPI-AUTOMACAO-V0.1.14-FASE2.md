# DESKDATA — CPI Central: fase 2 (filtro 29)

## Evidência do portal (capturas recebidas em 04/11/2026)

- Tela administrativa autenticada: `https://adm.cpicentral.com.br/zpersEspecial/pesquisas/aguardando/mod_t_aguardando.aspx`.
- Filtros avançados: `title="Filtros Avançados"`, elemento com evento `set_tipo_pesq()`.
- Checkbox do tipo: `input#id_tipo_pesq_29` — `PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF`.
- Confirmação do modal: link de nome `Selecionar`, disparando `set()`.
- Acionamento da listagem: `title="Mostrar Tudo"`, evento que define `textoSearch='*'` e chama `texto_change(1,0)`.
- Rodapé observado na tabela vazia: `Mostrando: 0 à 0 ( de 0 registro )`.
- A tela utiliza frames; o código procura controles em frames do domínio CPI, sem presumir índices.

## Escopo implementado

- Comando manual no Electron: **Filtrar pesquisa CPI 29**.
- Reutiliza o Edge autenticado e, se necessário, navega para a página de pesquisas aguardando.
- Abre os filtros avançados, desmarca outros tipos selecionados, marca exclusivamente o tipo 29, confirma e aciona Mostrar Tudo.
- Tenta reconhecer o total de registros pelo rodapé: `empty` (0), `found` (>0) ou `unconfirmed` (rodapé indisponível).
- O resultado devolvido ao renderer contém apenas o tipo e o total; não captura CPF ou conteúdo de linhas.

## Fora do escopo

- Extração de CPFs e abertura de solicitações; autenticação automática CPI; POST pago Deskdata; upload e salvamento de PDFs; fila FULL AUTO.
- Nenhum registro deve ser alterado nesta fase. Somente filtros visuais da página são acionados.
- Não está comprovado que a CPI aplica o filtro corretamente em todos os cenários enquanto não houver dados elegíveis para validar visualmente a coluna Tipo Pesquisa.
- A conclusão da filtragem depende do comportamento real da CPI, incluindo os frames e eventos do portal, e requer validação no Windows com sessão autorizada.

## Testes e critérios de aceite

1. Executar `npm run typecheck`, `npm test`, `npm run build` no projeto local.
2. Abrir DESKDATA e acessar **Automação CPI**.
3. Abrir Edge, autenticar manualmente na CPI e clicar **Filtrar pesquisa CPI 29**.
4. Conferir que o modal abre, somente o tipo 29 é selecionado e o comando `Mostrar Tudo` é executado.
5. Se não houver pesquisas, o Electron deve mostrar "Nenhuma pesquisa pendente encontrada", não erro.
6. Se houver pesquisas, comparar o total informado ao rodapé e confirmar visualmente que todas têm o tipo 29, sem abrir ou modificar registros.
7. Em caso de sessão expirada ou mudança no DOM, a automação deve parar e exibir erro, não operar outro controle como fallback arriscado.

## Observações operacionais

- Uma busca que mostra `0` é válida. Um rodapé não identificado resulta em `unconfirmed`, não em `0`.
- O rodapé não prova sozinho que todos os itens são do tipo 29; a verificação de elegibilidade linha a linha será adicionada na fase de leitura de registros.
- Não adicionar cookies, tokens, senhas ou dados pessoais às capturas e aos logs.
- Não fazer commit nem push até aprovação do usuário.

## Hotfix Fase 2.1 — checkbox em iframe fora do viewport

**Evidência em Windows:** `locator.check()` identificou `#id_tipo_pesq_29`, mas entrou em
espera até o timeout de 10 s com o erro *element is outside of the viewport*.
O modal havia sido aberto normalmente e a inspeção DOM confirmou o input do tipo 29.

**Correção:** após confirmar o ID e o atributo `value` do tipo 29, selecionar/desmarcar
usando o método nativo `HTMLInputElement.click()` dentro do frame correto; os handlers
`click`/`change` do portal continuam sendo disparados. O estado é verificado antes e
depois da alteração. Não são usados `force`, coordenadas de mouse ou atribuição direta
à propriedade `checked`. A confirmação do modal e a pesquisa continuam via Playwright.

**Limite de validação:** testes unitários reproduzem o comportamento esperado do controle
sem viewport; a eficácia no portal CPI real depende de novo teste autorizado no Windows.
Caso o controle não responda ao clique, a operação é interrompida sem salvar registros.
