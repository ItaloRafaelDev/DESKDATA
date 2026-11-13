# v0.1.11 — Acesso, avisos e interface

## Escopo

A atualização é **visual e local à interface React**. Não modifica contratos Deskdata, autorização de créditos, dados cifrados, IPC, processamento assíncrono, históricos ou geradores de PDF.

### Acesso

Ao abrir o aplicativo, o renderer verifica a presença de `credentials.bin` por meio das interfaces IPC existentes (`credentials:status` e `credentials:load`). Se houver credenciais protegidas e válidas, e o usuário não tiver iniciado edição manual enquanto ocorre a leitura, e-mail e senha são preenchidos automaticamente. A autenticação continua exigindo clique em **Autenticar**; nenhuma consulta à API é disparada por esse preenchimento.

A chave de proteção continua administrada pelo `safeStorage` no processo principal do Electron. Não são gravados dados adicionais nem introduzidos novos mecanismos de armazenamento. A ação **Esquecer** continua disponível.

### Notificações

Mensagens de operações agora são emitidas em toast no canto superior direito, sobrepondo o conteúdo sem deslocar a página. O toast pode ser fechado manualmente e some automaticamente (sucesso: 4,5 s; informação: 6 s; erro: 9 s). Utiliza `role="status"` ou `role="alert"` e contempla `prefers-reduced-motion`.

Não substitui feedback persistente relevante: indicadores de histórico, status da conta, botão desabilitado e validação nativa dos formulários continuam disponíveis.

### Layout

- Menu com ícones SVG consistentes, sem fontes externas ou novas dependências.
- Paleta navy/azul, cards e ações mais compactos.
- Em janelas largas, consulta e histórico lado a lado, reduzindo rolagem vertical.
- Histórico com sua própria rolagem; conteúdo principal e menu têm rolagem independente quando necessário.
- Em janelas menores, retorna para uma coluna e reduz a barra lateral.
- Mantém textos e funcionalidades das consultas Pessoa, PIS, CNPJ e Configurações.

## Validação

Execute no Windows:

```powershell
Set-Location 'I:\DEV\DESKDATA'
npm test
npm run typecheck
npm run build
npm run dev
```

Roteiro manual: (1) lembrar credenciais, encerrar e abrir o Electron, confirmar campos preenchidos sem autenticação automática; (2) clicar Autenticar e verificar toast temporário; (3) abrir as três consultas e rolar histórico; (4) verificar Configurações, sem acionar limpeza; (5) sair e voltar ao login; (6) testar erros de login sem iniciar consultas pagas.

**Limitação:** a execução de build e a inspeção visual da janela Windows não foram realizadas no ambiente Linux da geração, que não possui `node_modules` do projeto.

### Janela nativa

A barra de menu padrão do Electron fica oculta por `autoHideMenuBar:true`, mantendo acesso via `Alt` no Windows, sem remover os comandos.
