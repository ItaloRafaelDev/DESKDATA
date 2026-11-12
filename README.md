# DESKDATA

Aplicativo desktop para consultas na Deskdata, geração de relatórios PDF e automação de respostas no portal CPI Central.

A consulta de pessoas pela CPI está em desenvolvimento na branch `feature/cpi-automation`. Os módulos manuais de pessoa, PIS e CNPJ continuam disponíveis.

## O que faz

- Consulta CPF e CNPJ utilizando a API Deskdata e gera relatórios em PDF.
- Consulta PIS por CPF e emite o relatório quando a API disponibiliza o número.
- Mantém histórico separado por conta, com recuperação de consultas existentes por código.
- Na aba **Automação CPI**, monitora as pesquisas do tipo 29, consulta o CPF, classifica os processos, anexa o PDF e salva a resposta na CPI Central.
- Permite acompanhar o estado do agente, as respostas concluídas e os registros que precisam de revisão.

As consultas novas podem consumir créditos da Deskdata. O aplicativo exige autorização da conta e consulta o saldo antes de iniciar novas operações.

## Rodar em outro computador

### Requisitos

- Windows 11 de 64 bits.
- Node.js 24 e npm.
- Git, Microsoft Edge e acesso ao repositório.
- Credenciais da Deskdata e, para a automação, acesso autorizado ao portal administrativo da CPI Central.

No PowerShell, execute:

```powershell
git clone --branch feature/cpi-automation --single-branch https://github.com/ItaloRafaelDev/DESKDATA.git
cd DESKDATA
npm install
npm run dev
```

Nas próximas vezes, basta abrir a pasta do projeto e executar `npm run dev`.

Se o acesso ao repositório falhar, confira sua autenticação no GitHub. Para atualizar uma instalação já modificada, revise `git status` antes de trazer mudanças.

## Primeiro acesso

1. Entre no DESKDATA com sua conta Deskdata.
2. Em **Minha conta**, confira o saldo e autorize as consultas pagas.
3. Em **Configurações**, escolha a pasta onde os PDFs serão gerados.
4. Para consultas manuais, use **Consultar pessoa**, **Consultar PIS** ou **Consultar CNPJ**.
5. Para a CPI, entre em **Automação CPI**, abra o Edge, faça login no portal administrativo e clique em **Iniciar agente**.

O agente trabalha com uma solicitação por vez. Quando uma resposta não pode ser confirmada, o processamento é interrompido para revisão, sem reenviar automaticamente a consulta ou o anexo.

## Testar o código

```powershell
npm run typecheck
npm test
npm run build
```

Esses comandos verificam compilação e testes locais. O funcionamento completo da automação depende da sessão autorizada da CPI e de uma conta Deskdata com créditos. Testes automatizados não substituem essa validação.

## Instalador Windows

O projeto tem configuração para gerar um instalador NSIS x64, mas a distribuição exige assinatura digital e validação em outra máquina. Em um ambiente de build configurado, com `package-lock.json` versionado e certificado de assinatura disponível:

```powershell
.\scripts\build-windows.ps1
```

O instalador gerado deve ser testado antes de distribuir. Sem certificado ou lockfile, o script pode interromper a geração. Para executar o código em desenvolvimento, não é necessário criar um instalador.

## Dados e backups

- O histórico de consultas e os estados da automação são armazenados localmente com proteção criptográfica.
- Os relatórios são salvos na pasta configurada pelo usuário.
- Backups do aplicativo não incluem os PDFs.
- Dados cifrados vinculados ao Windows não devem ser simplesmente copiados para outro computador como método de migração.
- Nunca envie ao GitHub credenciais, CPFs de clientes, bancos de dados, PDFs, logs ou backups.

## Pastas principais

```text
src/main/       Electron, API, histórico, geração de PDF e automação CPI
src/preload/    Comunicação IPC
src/renderer/   Interface
src/shared/     Validações, normalização e modelos de relatórios
tests/          Testes automatizados
scripts/        Scripts de desenvolvimento e distribuição
docs/           Documentação técnica
```

## Versões

A branch `main` contém a base estável anterior (`v0.1.13`). A branch `feature/cpi-automation` reúne o desenvolvimento da automação CPI (`v0.1.14-dev.1`) e ainda exige homologação para um release de distribuição.

Documentação da API: https://docs.deskdata.com.br/reference/início
