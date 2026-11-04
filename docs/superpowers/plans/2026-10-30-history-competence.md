# DESKDATA History and Criminal Competence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Save retrieval codes securely, reuse prior queries, list PDFs independently and classify the PDF highlight by Competência Criminal.

**Architecture:** Electron main process owns the HTTPS client, encrypted index and PDF opening. Renderer receives only IPC methods for historical records and individual open operations. JSON contents remain in memory only; only metadata persist encrypted.

**Tech Stack:** Electron, TypeScript, React, Node.js built-ins, `safeStorage`.

**Spec:** `README.md` (v0.1.3 behavior), earlier `docs/IMPLEMENTACAO.md` (original constraints).

## Global Constraints

- Never create a second POST implicitly; persist an uncertain record before initiating a new POST.
- Validate the retrieved person's CPF before attaching a manually specified code.
- Store codes associated with the authenticated account, do not log JSON or credentials.
- Preserve every returned lawsuit and highlight only explicit criminal competence.
- Do not put supplier branding/source/model badge on customer PDF.

## Review Focus

- Incomplete GET: preserve code and do not create POST automatically.
- GET code from unrelated CPF: reject report association.
- Missing PDF: recover by GET only when code is known.
- Another authenticated account: cannot view the first account's index.
- Unknown result from POST: mark uncertainty and prevent duplicate charges.

## Tasks

- [x] Add tests for `query_code`, `query.code`, and GET-only recovery, then implement client support (`tests/api.test.mjs`, `src/main/deskdata-client.ts`).
- [x] Add tests for encrypted metadata, account isolation and restart then implement index (`tests/history.test.mjs`, `src/main/query-history.ts`).
- [x] Add tests for CPF identity matching and implement manual-code safeguards (`tests/query-identity.test.mjs`, `src/shared/query-identity.ts`).
- [x] Add tests for criminal competence and customer PDF presentation then update HTML report (`tests/report.test.mjs`, `src/shared/report.ts`, `src/main/pdf.ts`).
- [x] Add IPC for history list, per-file open, GET regeneration, code recovery (`src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts`).
- [x] Add scrollable historical results and individual open actions (`src/renderer/main.tsx`, `src/renderer/styles.css`).
- [x] Run tests and generate A4 preview with fictitious data; inspect content and rendering.
- [ ] Run `npm run typecheck` and `npm run build` with installed dependencies.
- [ ] Windows E2E: authenticate, GET historical code, independent PDF opens, restart persistence, observe any response contract drift.
