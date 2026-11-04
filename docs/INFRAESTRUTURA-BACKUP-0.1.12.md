# DESKDATA 0.1.12 — Persistência, backup, diagnóstico e distribuição

## Escopo implementado

- SQLite integrado via `node:sqlite` do Electron 45/Node 24, sem módulo nativo externo. Cada registro é cifrado individualmente com a proteção do Windows já usada pelo aplicativo. Índices HMAC por conta, tipo e identificador permitem consultas sem expor CPF/CNPJ ou e-mail no banco.
- Removido o teto artificial de 1.000 registros do histórico. Não equivale a escala ilimitada; testes de carga com dados reais continuam pendentes.
- Migração de `queries.bin` para `queries.sqlite` transacional na primeira abertura. `queries.bin` permanece intocado. Marcador interno evita reimportação após exclusão voluntária de histórico.
- Armazenamento estável em `%APPDATA%\deskdata-desktop` tanto no DEV quanto após instalação.
- Eventos operacionais JSONL com campos permitidos (`channel`, duração, status, contagens) em `%APPDATA%\deskdata-desktop\logs`; até cinco arquivos de até cerca de 5 MB antes da rotação. Nenhum request body, senha, token, CPF/CNPJ ou dados judiciais é escrito pelo logger.
- Bloqueio de instância duplicada do Electron para reduzir risco de consultas simultâneas pelo mesmo perfil.
- ZIP manual pelo botão em Configurações, com snapshot consistente do banco, chave cifrada de índice, autorização cifrada de créditos (se existir) e configuração local cifrada. Inclui manifesto com hashes SHA-256.
- Botões Configurações: `Criar backup ZIP`, `Abrir pasta de backups`, `Abrir logs de diagnóstico`.
- Instalador Windows NSIS x64 com opção por usuário e política de assinatura obrigatória, via electron-builder v26.18.0.

## Pastas

| Tipo | Desenvolvimento | Aplicativo instalado |
|---|---|---|
| Histórico | `%APPDATA%\deskdata-desktop\queries.sqlite` | Mesmo caminho |
| Chave | `%APPDATA%\deskdata-desktop\history-key.bin` | Mesmo caminho |
| Logs | `%APPDATA%\deskdata-desktop\logs` | Mesmo caminho |
| Backups | `I:\DEV\DESKDATA\backups` quando iniciado dessa raiz | `%APPDATA%\deskdata-desktop\backups` |
| PDFs | Pasta definida em Configurações | Mesma pasta configurada |

## Conteúdo do backup

- `history.sqlite`: transações e histórico, com registros cifrados.
- `history-key.bin`: chave HMAC protegida com DPAPI da conta Windows.
- `history-state.flag`: marcador que impede reinicialização silenciosa do histórico se o banco desaparecer.
- `credit-approvals.bin`: autorizações cifradas, quando existir.
- `settings.bin`: pasta configurada cifrada.
- `manifest.json`: data, número de registros, tamanhos e hashes de cada componente.

**Não entram no ZIP:** PDF, credenciais de login, senhas, JWTs, logs técnicos ou respostas completas da API. O próprio ZIP não tem senha; as partes sensíveis dentro dele estão cifradas. Não compartilhar publicamente. A restauração automática ainda não foi implementada. Como o histórico depende da DPAPI, copiar o ZIP para outro computador/usuário não garante leitura. Não substitui backup Windows corporativo.

## Distribuição

1. No Windows 11, com o projeto completo, execute `npm install` para gerar `package-lock.json`; revise e preserve esse lockfile no repositório. Builds seguintes devem usar `npm ci`.
2. Configure certificado de assinatura de código legítimo, sem inserir chaves privadas no repositório.
3. Execute `powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1`.
4. O script exige testes, typecheck e build. Ele também confere a assinatura Authenticode dos executáveis emitidos e apresenta SHA-256. Qualquer falha interrompe a operação.
5. Teste instalador em ambiente Windows limpo, inclusive atualização mantendo histórico e credenciais, e verifique a instalação no diretório por usuário.

**Limitações da entrega:** instalador não foi compilado neste ambiente; dependências npm para typecheck/build não estão instaladas, e assinatura digital não está configurada. O script de distribuição requer validação no Windows com certificado.

## Homologação antes de alterar dados reais

1. Fazer cópia de segurança da pasta `%APPDATA%\deskdata-desktop` existente.
2. Confirmar que `queries.bin`, créditos, configurações e credenciais permanecem presentes.
3. Instalar a atualização, autenticar e confirmar os registros de CPF, PIS e CNPJ anteriores. Nenhum POST deve ser feito nessa etapa.
4. Clicar em Criar backup ZIP, abrir pasta e verificar manifesto, arquivos e integridade ZIP.
5. Testar reinício, regeneração com GET e alteração de histórico sem mudança de conta.
6. Conferir logs e ausência de dados pessoais nos arquivos JSONL.
7. Testar o mesmo fluxo após build assinado em máquina de homologação.
