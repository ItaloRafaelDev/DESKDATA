# Hotfix 6D — Leitura dos cabeçalhos CPI

**Escopo:** validação do detalhe da pesquisa CPI 29. Não altera consultas Deskdata, PDF, uploads, salvamento, configuração de saldo ou histórico.

## Diagnóstico
O validador anterior comparava títulos com texto integral e uma única variante (`Dados Solicitação N`). O portal pode apresentar `Dados da Solicitação: N` ou separadores diferentes. Além disso, a leitura anterior procurava IDs por substring, não por correspondência completa.

## Alteração
- Permite apenas as variantes conhecidas de títulos `Dados [da] Solicitação` e `Dados da Pesquisa` (separadores espaço, `-`, `:` ou `#`).
- Extrai IDs numéricos completos e compara ambos **exatamente** com os IDs da listagem.
- Mensagens diferentes para título inesperado e formulário de outra solicitação; nenhuma informação pessoal nos erros.
- Mantém bloqueios para modalidade divergente, pesquisa já respondida e CPF inválido/ausente.
- Nenhum retry de POST, reenvio de PDF ou alteração do banco.

## Homologação pendente
O teste anterior foi realizado em um cadastro `CPF + Dados P.F.`. As capturas não comprovam se o CPF completo está disponível no DOM desse formulário. Se o título for aceito mas o CPF estiver ausente, o agente deve **parar** em vez de inferir o CPF a partir do nome ou RG.

Testar com uma única solicitação de teste, preservando o estado da fila. Não reprocessar registros já respondidos. Executar typecheck, testes e build no Windows.
