# DESKDATA 0.1.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remember credentials securely on Windows, present report in pt-BR and Model 01, open the generated PDF directly.

**Architecture:** Keep the existing Electron main/preload/React renderer structure, add a testable credential-storage service using the Electron OS encryption provider, and replace generic JSON dumping with explicit report-section mappings. IPC owns the file path for opening the most recently generated PDF.

**Tech Stack:** Electron 45, React 19, TypeScript, Node test runner, CSS print.

**Spec:** User chat, reference `DESKDATA_Modelo_01_Executivo_Minimalista.pdf`, actual generated `DESKDATA_14996213884_2026-10-30.pdf`, and official Deskdata processes dataset documentation.

## Global Constraints

- Do not issue any live API calls or consume credits during implementation or validation.
- Do not copy actual personally identifiable information into tests or demonstration.
- Keep five datasets and all lawsuit records, with only expressly Criminal `sphere` highlighted in red.
- No plaintext password stored on disk; prevent credential disclosure in logs.
- Preserve folder and payment-authorization settings. Do not overwrite existing customer PDFs.
- Preserve current Electron IPC guard and sandbox.

## Review Focus

- Name nested in `basic.name.full_name` must appear in identity banner.
- Valid ISO dates and Brazilian phone/CEP formatting; invalid/zero-year dates must not be invented.
- Process parties, events, petition and decision list preservation, role translation and criminal-only red style.
- Encryption unavailable, corrupted saved credential file, explicit deletion and no password in settings JSON.
- Opening a PDF must only target a file created by this session, not an arbitrary path from renderer.

---

### Task 1: Report localization and Model 01

**Files:** Create `src/shared/localization.ts`; modify `src/shared/report.ts`; create `tests/localization.test.mjs`; extend `tests/report.test.mjs`.

**Interfaces:** `formatDatePtBr`, `translateEnum`, `formatPhoneRecord`, `formatAddressRecord`, `formatCaseNumber`, `renderReportHtml`.

- [ ] Write failing localization and report tests with fictional payloads.
- [ ] Run `npm test` and confirm expected failures.
- [ ] Implement explicit mapping for known Deskdata fields and print styles matching Model 01.
- [ ] Run tests; inspect PDF render from fictional data.

### Task 2: Protected saved access

**Files:** Create `src/main/credentials.ts`; modify `src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/renderer/main.tsx`; create `tests/credentials.test.mjs`.

**Interfaces:** `CredentialStore`, `credentialsStatus`, `loadSavedCredentials`, `forgetSavedCredentials`, `authenticate(email,password,remember)`.

- [ ] Add failing tests for encrypted storage, no plaintext on disk, delete, and invalid stored data.
- [ ] Run tests, then implement using Electron `safeStorage` asynchronous encryption (Windows DPAPI).
- [ ] Load password only when user clicks prefill; save only after successful login.
- [ ] Validate tests and TypeScript.

### Task 3: Open most recent PDF

**Files:** Modify `src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/renderer/main.tsx`.

**Interfaces:** `openLastPdf()` IPC no path argument.

- [ ] Implement open operation using `shell.openPath` on the main process, with in-memory last PDF path and file existence check.
- [ ] Add the `Abrir PDF` button next to `Abrir pasta` only after successful generation.
- [ ] Test build, compile and UI where executable dependencies are available.

### Task 4: Packaging and handoff

**Files:** `README.md`, `docs/IMPLEMENTACAO.md`; full and patch zip packages.

- [ ] Run all available tests, typecheck and build; document unverified Windows/Electron items.
- [ ] Package only changed files in patch zip with `DESKDATA/` path and create full project zip.
- [ ] Provide incremental PowerShell instructions with backup before applying.
