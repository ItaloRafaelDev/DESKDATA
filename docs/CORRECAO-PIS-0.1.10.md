# Correção PIS — DESKDATA v0.1.10

## Defeito observado

Na versão 0.1.9, a ausência de `data.basic.social_security.number` gerava uma exceção em `normalizePisResult`. A interface exibia um erro remoto, o histórico permanecia sem classificação específica, e o usuário precisava decidir manualmente se deveria solicitar uma nova consulta.

## Regra implementada

- Validar resposta global, dataset `basic` e correspondência do CPF antes de classificar a ausência.
- Quando `social_security.number` estiver ausente, nulo ou vazio, persistir `status: pis_unavailable`, sem PDF.
- Na interface, exibir **PIS não informado** e **Número do PIS não disponibilizado pela Deskdata nesta consulta. Nenhum PDF foi gerado.**
- Preservar `queryCode`, quando retornado, para permitir **Verificar novamente via GET**, sem novo POST.
- Em novas tentativas pelo formulário, reutilizar o estado `pis_unavailable`; não iniciar outra consulta cobrada.
- Se uma recuperação manual passar a retornar número válido, gerar PDF e restaurar `status: ready` no mesmo registro.
- Se o número estiver presente mas tiver formato inválido, manter erro explícito de contrato; não afirmar que o número está ausente.
- Não alterar os módulos de Pessoa ou CNPJ.

## Segurança e migração

Não há migração destrutiva: o formato anterior de `queries.bin` continua aceito, com mais um valor permitido para `status`. O registro de um caso antigo sem PDF será convertido para o novo estado na próxima recuperação bem-sucedida pelo código já existente. Não são armazenadas respostas JSON com dados pessoais.

## Verificações

Execute no Windows, na pasta do projeto:

```powershell
npm test
npm run typecheck
npm run build
npm run dev
```

Testar recuperação de uma consulta anterior sem PIS via botão **Regerar PDF via GET**. O registro deve mudar para **PIS não informado**, sem PDF. Uma nova tentativa pelo formulário não deve enviar POST.

Os testes locais utilizam dados sintéticos. Não foi executada consulta real à API nesta correção. O campo `social_security.number` é a origem usada pelo projeto para o identificador previdenciário, sem afirmar que a resposta distingue formalmente PIS, NIS e NIT.
