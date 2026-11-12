# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DESKDATA is a Windows Electron + React desktop app (pt-BR) that queries the Deskdata API (CPF, PIS, CNPJ), generates PDF reports, and automates replying to "tipo 29" person searches on the CPI Central admin portal. All user-facing text, error messages, and docs are in Brazilian Portuguese — keep new strings in pt-BR.

## Commands

- `npm run dev` — run the app (electron-vite; `predev` runs `install-electron --no`).
- `npm run typecheck` — `tsc --noEmit`; the build does not typecheck, so run this separately.
- `npm test` — all tests: `node --experimental-strip-types --test tests/*.test.mjs` (Node 22).
- Single test file: `node --experimental-strip-types --test tests/cpi-full-cycle.test.mjs` (add `--test-name-pattern "<name>"` to narrow).
- `npm run build` — bundles main/preload/renderer into `out/`.
- `npm run test:demo`, `test:demo:pis`, `test:demo:cnpj` — render sample report HTML with synthetic data (no network).
- Installer: `.\scripts\build-windows.ps1` (`dist:win`); needs a code-signing certificate (`forceCodeSigning: true`) and the versioned `package-lock.json`. npm is the package manager of record; the pnpm files are leftovers.

The README's validation trio is `npm run typecheck && npm test && npm run build`. Real end-to-end behavior needs an authorized CPI session plus a Deskdata account with credits, which tests can't cover.

## Architecture

- **src/main** (Electron main process) owns everything privileged: network (`deskdata-client.ts`), tokens and credentials, encryption, filesystem, PDF generation (`webContents.printToPDF` via `pdf.ts`), and history (`query-history.ts`, `node:sqlite` `DatabaseSync`, per account).
- **src/preload/index.ts** exposes a typed `DesktopApi` (defined in `src/shared/types.ts`) through `contextBridge`. Preload is built as CJS (`index.cjs`) — see `electron.vite.config.ts`.
- **src/renderer** is React UI only; it never talks to the network or disk directly. `CpiPendingPanel.tsx` is the CPI automation tab.
- **src/shared** holds pure logic shared by main and tests: CPF/CNPJ validation, response normalization (`normalizer.ts`), report HTML builders (`report.ts`, `pis-report.ts`, `company-report.ts`), judicial classification (`judicial.ts`).
- **IPC**: every channel is registered via `bind()` in `src/main/index.ts`, which runs `guard()` (only the main window's main frame may call), routes work through `operations.ts` (exclusive vs. concurrent operations, shutdown draining), and logs sanitized diagnostics. New channels must go through `bind()`, and must be added to `exclusiveChannels` when they mutate shared state. `cpi:close` and `auth:logout` first pause the auto runner and stop the monitor.
- **src/main/cpi** is the CPI automation. `cpi-browser.ts` drives Microsoft Edge with `playwright-core` (`chromium.launch({ channel: 'msedge', headless: false })`); the user logs in manually. `pending-monitor.ts` / `full-auto-runner.ts` schedule cycles; `full-cycle.ts` (`executeCpiPersonCycle`) runs one request end to end: claim → Deskdata query → classify (`person-rules.ts`) → PDF → upload and save → confirm (`response-confirmation.ts`). Progress is persisted, encrypted, in `workflow-store.ts` with stages `claimed → query_started → query_pending → pdf_ready → submit_started → completed`, or `verification_required` / `review_required`. `workflow-reconciliation.ts` and `person-recovery.ts` resume from those stages after crashes.
- **Encryption**: `credentials.ts` abstracts Electron `safeStorage` (DPAPI) behind `CredentialProtector`, so stores can be tested with a fake protector.

## Invariants (don't break these)

- **No duplicate paid queries.** A 202 reuses the existing `query_code` (polling, no new POST). If a POST's response is lost after sending, it is never retried automatically. In CPI, any state that can't be confirmed (`submit_started`, `verification_required`) stops for human review — never automatically resubmit a query or attachment.
- Paid queries require per-account approval (`account-approval.ts`) and a balance check (`cpi/paid-balance.ts`).
- Never persist raw API responses, passwords, or tokens to disk. The workflow store holds no CPF, document, or PDF content. Never log CPFs or personal data; diagnostics and UI errors go through sanitizers (e.g. `safeCpiCycleError`).
- Report HTML must escape all API content. A missing or failed dataset must block the PDF rather than produce one that looks complete. "Criminal" sphere is only an indicator (shown in red), not a judgment of guilt.
- Session/account switches abort in-flight CPI work (`sessionAccount !== who` checks).
- Don't commit credentials, real CPFs, databases, PDFs, logs, or backups. Tests use synthetic CPFs (e.g. `52998224725`).

## Code and test conventions

- Tests are `.mjs` files that import `.ts` sources directly via Node type stripping. Source TypeScript must therefore stay erasable: no `enum`, `namespace`, or constructor parameter properties, and relative imports keep the `.ts` extension (`allowImportingTsExtensions`).
- `tests/helpers/main-process.mjs` (`withMainProcess`) loads the real `src/main/index.ts` in a VM with a stubbed `electron` module, so IPC handlers and lifecycle can be tested without Electron. `tests/helpers/cpi-portal.mjs` fakes the CPI portal; `history-store.mjs` builds temporary history stores.
- Code style is dense (compact single-line functions, minimal whitespace) — match the surrounding file.
- `docs/` holds per-version and per-phase design notes (e.g. `CPI-*.md`, `docs/superpowers/plans/`). Read the relevant one before changing CPI behavior.
- Commits use conventional style with a scope, e.g. `fix(cpi): ...`.
