# DESKDATA — Consultar CNPJ (DEV 0.1.5)

## Escopo

Novo item **Consultar CNPJ** após **Consultar PIS**, preservando módulos de pessoas e PIS. Formulário de CNPJ com validação de dígitos verificadores, sessão Deskdata existente e autorização de consumo compartilhada. Um POST lógico por consulta inédita.

**Contrato documentado:** `POST https://api.deskdata.com.br/queries` com:

```json
{"type":"companies","key_type":"cnpj","key_value":"<14 dígitos>","datasets":["basic","phones","addresses","emails","relationships","lawsuits"]}
```

Conforme https://docs.deskdata.com.br/llms.txt e páginas dos seis conjuntos. O dataset adicional solicitado `relationships_phones` está marcado **temporariamente indisponível**, por isso não é enviado e não aparece no relatório. O exemplo PDF de 70 páginas contém endereços de pessoas relacionadas, dataset **não solicitado e igualmente indisponível**; não incluímos esse material fora do escopo aprovado.

## Fluxo

1. Validar CNPJ; autenticação, pasta de saída e autorização de consumo já existentes.
2. Ler índice cifrado com escopo de conta + `kind=company` + CNPJ.
3. Se PDF local existe, reabrir sem HTTP. Se o registro tem código e não há arquivo, `GET /queries/{query_code}`. Se já há consulta incerta sem código, bloquear novo POST e orientar conferência.
4. Se consulta inédita autorizada, verificar crédito, gravar entrada incerta antes do POST e chamar somente os seis datasets disponíveis.
5. Registrar código de recuperação da API, quando fornecido; processar retorno 200/4000 ou 202/4008.
6. Validar todos os seis datasets individualmente. Omitir apenas listas comprovadamente vazias por `items: []` ou `total: 0`. Não exportar PDF quando há dataset ausente/erro parcial.
7. Confirmar que o CNPJ pertence ao retorno recebido antes de associar ao histórico e gerar PDF `CNPJ_<14 dígitos>_<AAAA-MM-DD>.pdf`, com sufixo caso já exista.
8. Cada PDF permanece no histórico independente com botão próprio **Abrir PDF** e recuperação via GET quando houver código.

## Relatório

A4, executive minimalista, campos pt-BR, sem nome da origem/fornecedor. Seções: identificação empresarial e informações cadastrais, atividades econômicas, e-mails, endereços, telefones, relacionamentos, processos judiciais. Incluir todos os processos, suas partes, movimentos, petições e decisões disponíveis. Apenas `court_type` / `competence` / `competencia` com valor Criminal recebe destaque vermelho. Não avaliar culpa nem criar fatos.

O PDF de referência do usuário contém 70 páginas. O volume final depende do que a API efetivamente retornar. Há suporte a paginação CSS, mas é necessária validação com retorno completo de grande porte antes de considerar a geração homologada.

## Segurança e limitações

- Índice cifrado pelo safeStorage Electron. Contém identificação, código, caminhos, não JSON empresarial completo.
- As chamadas reais são feitas no processo principal, não pelo renderer. IPC valida origem e ID.
- O código foi testado com dados fictícios; mapeamentos dos campos empresariais exigem comparação com JSON real mascarado da API.
- A retenção e os acessos aos PDFs devem ser controlados no Windows.
- Não executar consulta real sem autorização consciente do crédito consumido; um HTTP 200 não garante que todos os datasets vieram válidos.
- Não confundir renderização da demonstração via WeasyPrint com teste do Electron (`webContents.printToPDF`).

## Verificação no Windows

```powershell
Set-Location I:\DEV\DESKDATA
npm test
npm run typecheck
npm run build
npm run dev
```

Após passar as três primeiras verificações, testar navegação, validação CNPJ, consulta com código já conhecido, salvamento e abertura. Somente com autorização fazer uma nova consulta cobrada.
