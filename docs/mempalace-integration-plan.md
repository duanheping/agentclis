# MemPalace Integration Plan

Status: Approved
Owner: agentclis
Decision date: 2026-04-15

## Source Of Truth

This document is the execution reference for integrating MemPalace into `agentclis`.

Execution rule:
- Every implementation step for this feature must be checked against this document before code changes start.
- After each completed step, review this document again and confirm the work is still aligned with the approved architecture, boundaries, and deprecation plan.
- If implementation pressure conflicts with this document, update the plan first, then change code.

## Decision Summary

Use MemPalace as the primary durable memory backend for `agentclis`, while keeping `agentclis` in control of:
- transcript capture
- logical project identity and location grouping
- session lifecycle
- provider startup injection
- renderer and IPC ownership
- startup bootstrap composition

MemPalace will own:
- durable searchable storage
- raw transcript retrieval
- structured memory card storage
- search, fetch, and later timeline-style recall

## Architecture Boundaries

Keep these modules as the control plane:
- `electron/transcriptStore.ts`
- `electron/sessionManager.ts`
- `electron/projectIdentity.ts`
- `electron/codexInstructions.ts`
- `electron/copilotInstructions.ts`

Do not replace:
- transcript persistence
- project grouping logic
- provider-native startup injection
- the fire-and-forget terminal input path

Replace or shrink the current long-term memory backend behind:
- `electron/projectMemoryService.ts`
- `electron/projectMemoryManager.ts`

## MemPalace Runtime Strategy

MemPalace must not be added as:
- a git submodule
- a vendored source tree inside this repo

MemPalace must be integrated as a pinned external runtime installed from GitHub.

Pinned source:
- Repo: `https://github.com/duanheping/mempalace.git`
- Commit: `74e5bf6090cb239b1b48b5a015670842a99a2c8c`
- Minimum Python: `>=3.9`

Install location:
- `%APPDATA%\agentclis\tools\mempalace\<commit>\`

Palace data root:
- `%APPDATA%\agentclis\mempalace\palace\`

Start command:
- `python -m mempalace.mcp_server --palace <path>`

Guidance:
- Start with a GitHub-pinned install from the fork, not PyPI.
- Runtime installation failures must never block session startup.

## Ownership Model

`agentclis` owns:
- capture
- bootstrap composition
- project identity
- provenance mapping
- session lifecycle and UI

`mempalace` owns:
- durable storage
- retrieval
- optional later graph-based exploration

`mempalace` must not decide:
- when sessions are captured
- how providers are injected
- how logical projects are grouped
- how prompt composition works

## Data Model

Palace topology:
- one app-managed palace, not one palace per checkout
- `wing = logical project id` or remote fingerprint
- never use raw checkout path as the wing id

Initial room taxonomy:
- `transcript-raw`
- `decision`
- `workflow`
- `troubleshooting`
- `preference`
- `critical-file`
- `session-summary`
- `architecture`

Two stored memory forms:
1. Raw transcript chunks
2. Structured memory cards extracted by `agentclis`

Required sidecar metadata per indexed item:
- `drawerId`
- `projectId`
- `locationId`
- `sessionId`
- `eventIds`
- `timestampStart`
- `timestampEnd`
- `sourceKind`
- `room`
- `wing`
- optional `legacyArtifactPath`

## What MemPalace Will Be Used For

MemPalace will be used for:
- raw transcript memory
- structured memory card storage
- explicit search, fetch, and later timeline flows

MemPalace will not initially be used for:
- direct startup prompt generation
- mid-session hidden prompt updates
- repo-wide file mining as the primary live session capture path

Important guidance:
- Do not use `mempalace mine` for live session capture.
- Live session indexing must come from `TranscriptStore`, not from scanning repo files.
- For migration or selective offline import, `mempalace mine` can be used if necessary, but it is not the primary path.

## Features To Keep

Keep:
- `TranscriptStore` as the canonical append-only event log
- `SessionManager` as the single owner of project and session state
- project and location grouping
- startup-only provider injection
- architecture analysis as a product feature
- historical session analysis as a product feature
- renderer and IPC ownership through `src/shared/ipc.ts`, preload, and main

## Features To Stop Investing In Immediately

Stop investing in:
- any new custom retrieval backend inside Electron
- treating `SkillLibrarySettings.libraryRoot` as the gate for memory availability
- expanding `.agenclis-memory/projects/...` as the long-term source of truth
- tying project-memory UX to the Skills settings panel

## Features To Deprecate Later

Deprecate later:
- `writeCanonicalArtifacts()` as the primary persistence boundary
- `.agenclis-memory/memory.md`, `critical-files.md`, `troubleshooting.md`, `architecture.md`, and `sessions-analysis.md` as authoritative runtime inputs
- direct bucket-file-driven `assembleContext()` logic as the long-term startup source
- historical refresh paths whose main job is regenerating `.agenclis-memory` artifacts

Do not remove these until MemPalace-backed startup composition is proven.

## Migration Rules

Migration mode:
- existing `.agenclis-memory` is read-only during migration

Importer responsibilities:
- summaries -> `session-summary`
- facts -> `decision` or appropriate preserved card category during import design
- decisions -> `decision`
- preferences -> `preference`
- workflows -> `workflow`
- troubleshooting -> `troubleshooting`
- debug approaches -> `troubleshooting` unless a dedicated later room is added
- project conventions -> keep as structured cards for bootstrap composition
- critical files -> `critical-file`
- architecture docs -> `architecture`
- sessions-analysis docs -> `session-summary` or dedicated later category if needed

Migration requirements:
- preserve original file paths in metadata
- keep imports idempotent
- record migration state so the import can resume safely
- do not migrate transient injected marker blocks
- after migration, all new writes go only to MemPalace

## Target Module Breakdown

Add:
- `third_party/mempalace.json`
- `electron/mempalaceRuntime.ts`
- `electron/mempalaceBridge.ts`
- `electron/mempalaceService.ts`
- `electron/mempalaceIndexer.ts`
- `electron/bootstrapComposer.ts`
- `src/shared/memorySearch.ts`
- `src/components/MemorySearchPanel.tsx`
- `src/components/MemoryBackendSettings.tsx`

Change:
- `electron/main.ts`
- `electron/preload.ts`
- `src/shared/ipc.ts`
- `src/components/SessionSidebar.tsx`
- `src/App.tsx`
- `electron/projectMemoryService.ts`
- `electron/projectMemoryManager.ts`

## Phase Plan

### Phase 0: Runtime And Wiring

Goal:
- make MemPalace installable, pinnable, spawnable, observable, and non-disruptive

Exit criteria:
- app startup unchanged
- backend install can succeed or fail without affecting session startup
- MemPalace status is visible in UI
- basic search IPC works if backend is available

### Phase 1: Raw Transcript Indexing And Search

Goal:
- index transcript chunks from `TranscriptStore` into MemPalace
- search them from the app
- preserve provenance back to sessions and transcript events

Exit criteria:
- closed/backfilled sessions index into MemPalace
- search works from UI
- search hits resolve back to the source session
- current startup memory behavior remains unchanged

### Phase 2: Structured Memory Cards And Bootstrap Composer

Goal:
- store extracted structured cards in MemPalace
- introduce `BootstrapComposer`
- keep `.agenclis-memory` as fallback

Exit criteria:
- startup bootstrap can be composed from MemPalace-backed structured cards
- fallback path remains available

### Phase 3: Source Of Truth Switch

Goal:
- switch durable memory source of truth to MemPalace
- keep `.agenclis-memory` only as export/debug

Exit criteria:
- no runtime dependency on canonical markdown/json artifact files
- MemPalace is authoritative for retrieval and bootstrap composition

### Phase 4: Optional Direct Agent Access

Goal:
- optional MCP exposure to live agents
- optional knowledge-graph features if they prove useful

Exit criteria:
- direct agent access does not weaken prompt-injection or startup guarantees

## Ticket Breakdown

### P0-01 Third-Party Lock Manifest

Files:
- `third_party/mempalace.json`

Work:
- add pinned repo metadata
- define install root convention
- define palace data root convention

Acceptance:
- manifest is the only committed source of truth for MemPalace version pinning

Estimate:
- 0.25 day

Dependencies:
- none

### P0-02 Shared Memory Backend Types

Files:
- `src/shared/memorySearch.ts`
- `src/shared/ipc.ts`

Work:
- add status/install/search types
- add `memory:get-status`
- add `memory:install-runtime`
- add `memory:search`
- extend `AgentCliApi`

Acceptance:
- all memory backend IPC is typed centrally

Estimate:
- 0.5 day

Dependencies:
- P0-01

### P0-03 Preload API Wiring

Files:
- `electron/preload.ts`

Work:
- expose the new memory backend APIs through `window.agentCli`

Acceptance:
- renderer can call status/install/search through preload

Estimate:
- 0.25 day

Dependencies:
- P0-02

### P0-04 MemPalace Runtime Manager

Files:
- `electron/mempalaceRuntime.ts`

Work:
- path helpers
- install flow
- version checks
- process spawn/stop
- health tracking
- diagnostics

Acceptance:
- runtime can be installed and status queried without affecting sessions

Estimate:
- 1.5 days

Dependencies:
- P0-01

### P0-05 MemPalace Bridge

Files:
- `electron/mempalaceBridge.ts`

Work:
- JSON-RPC/MCP stdio request/response
- `tools/list`
- `tools/call`
- wrappers for `mempalace_status` and `mempalace_search`
- timeout and restart handling

Acceptance:
- basic MemPalace tool calls return parsed results

Estimate:
- 1 day

Dependencies:
- P0-04

### P0-06 MemPalace Service

Files:
- `electron/mempalaceService.ts`

Work:
- compose runtime and bridge
- expose `getStatus()`
- expose `installRuntime()`
- expose `search()`
- normalize backend failures into non-fatal app behavior

Acceptance:
- main process has one stable service surface

Estimate:
- 0.75 day

Dependencies:
- P0-05

### P0-07 Main Process Wiring

Files:
- `electron/main.ts`

Work:
- instantiate runtime and service
- add IPC handlers for status/install/search
- keep all session and provider flows unchanged

Acceptance:
- app boots with new handlers and no session behavior change

Estimate:
- 0.5 day

Dependencies:
- P0-06

### P0-08 Memory Backend Settings UI

Files:
- `src/components/MemoryBackendSettings.tsx`
- `src/components/SessionSidebar.tsx`
- `src/App.tsx`

Work:
- add separate memory backend section
- show install status, pinned commit, palace path, last error
- add actions: install, retry, open palace path

Acceptance:
- user can inspect and manage backend state from the UI

Estimate:
- 1 day

Dependencies:
- P0-03
- P0-07

### P0-09 Phase 0 Tests

Files:
- `electron/mempalaceRuntime.test.ts`
- `electron/mempalaceBridge.test.ts`
- `electron/mempalaceService.test.ts`
- `src/shared/memorySearch.test.ts`

Work:
- cover path resolution
- cover state transitions
- cover spawn failure handling
- cover bridge request parsing
- cover non-fatal fallback behavior

Acceptance:
- targeted tests and `npm run build` pass

Estimate:
- 1 day

Dependencies:
- P0-08

### P1-01 Transcript Chunk Schema

Files:
- `src/shared/memorySearch.ts`
- optional `src/shared/memoryIndex.ts`

Work:
- define deterministic chunk identity and provenance schema

Acceptance:
- stable schema exists for transcript-backed memory items

Estimate:
- 0.5 day

Dependencies:
- P0-09

### P1-02 Transcript Chunker

Files:
- `electron/mempalaceIndexer.ts`

Work:
- read transcript events from `TranscriptStore`
- group events into deterministic chunks
- generate content plus provenance metadata
- skip empty/low-signal transcripts

Acceptance:
- one transcript always yields the same chunk set

Estimate:
- 1.5 days

Dependencies:
- P1-01

### P1-03 Bridge Write And Fetch Support

Files:
- `electron/mempalaceBridge.ts`

Work:
- add wrappers for `mempalace_add_drawer`
- add wrappers for `mempalace_get_drawer`
- optionally add list support

Acceptance:
- app can write and fetch specific drawers

Estimate:
- 0.5 day

Dependencies:
- P1-02

### P1-04 Indexing Service Methods

Files:
- `electron/mempalaceService.ts`

Work:
- add `indexSessionTranscript(...)`
- add `getItems(ids[])`
- keep indexing idempotent
- add optional provenance registry if required

Acceptance:
- service can index and fetch transcript-derived items

Estimate:
- 1 day

Dependencies:
- P1-03

### P1-05 Hook Into Existing Capture And Backfill

Files:
- `electron/projectMemoryService.ts`
- possibly `electron/sessionManager.ts`

Work:
- call MemPalace transcript indexing from the existing durable capture points
- do not change the live typing path
- do not index per keystroke

Acceptance:
- indexing happens on close, exit, or backfill

Estimate:
- 0.75 day

Dependencies:
- P1-04

### P1-06 Reindex Project Command

Files:
- `src/shared/ipc.ts`
- `electron/preload.ts`
- `electron/main.ts`
- `electron/mempalaceService.ts`

Work:
- add `memory:reindex-project`
- enumerate sessions by project
- skip empty transcripts
- report indexed/skipped/error counts

Acceptance:
- user can rebuild transcript memory for a project on demand

Estimate:
- 0.75 day

Dependencies:
- P1-05

### P1-07 Search Panel UI

Files:
- `src/components/MemorySearchPanel.tsx`
- `src/App.tsx`
- possibly `src/components/SessionSidebar.tsx`

Work:
- add query box
- add optional project filter
- render hits with session and timestamp context
- add open-source-session action

Acceptance:
- transcript memory is searchable from the app UI

Estimate:
- 1.25 days

Dependencies:
- P1-06

### P1-08 Provenance And Open-Source Mapping

Files:
- `electron/mempalaceService.ts`
- `src/shared/memorySearch.ts`
- renderer files from P1-07

Work:
- ensure every search hit includes source session metadata
- support opening the matching session from a hit
- if event-range highlighting is unavailable, document that explicitly

Acceptance:
- every hit resolves to a source session or is marked unresolved

Estimate:
- 0.75 day

Dependencies:
- P1-07

### P1-09 Keep Legacy Startup Memory Path Intact

Files:
- none removed in Phase 1

Work:
- keep `assembleContext()` behavior unchanged
- keep project-memory analysis windows unchanged
- keep existing `.agenclis-memory` read path unchanged

Acceptance:
- search is added without changing startup memory behavior

Estimate:
- 0 day, but mandatory review gate

Dependencies:
- P1-08

### P1-10 Phase 1 Tests

Files:
- `electron/mempalaceIndexer.test.ts`
- update service and project-memory tests
- UI tests for memory search panel

Work:
- deterministic chunking
- idempotent indexing
- non-empty transcript filtering
- reindex behavior
- search hit provenance
- graceful backend failure handling

Acceptance:
- targeted tests and `npm run build` pass

Estimate:
- 1.25 days

Dependencies:
- P1-09

## Validation Checklist

Phase 0 manual checks:
- install backend from a clean machine state
- restart app and verify status persists
- stop backend and confirm session startup still works
- inspect diagnostics on spawn failure

Phase 1 manual checks:
- run a session and close it
- verify transcript indexing occurred
- search for unique transcript text
- open the source session from the hit
- verify Codex/Copilot startup injection still behaves exactly as before
- verify architecture/session analysis windows still work

Global validation:
- always run `npm run build`

## Rollback Rules

- keep memory backend behind a setting or feature flag until Phase 3
- if MemPalace fails, fall back to the current startup path and disable only deep recall
- do not delete `.agenclis-memory` generation until the MemPalace-backed bootstrap path is proven

## Working Agreement For Implementation

For every future implementation step on this feature:
- read this document before making changes
- state which ticket is being executed
- after the step is complete, review this document and confirm the work still matches the approved plan
- if the code reveals a necessary deviation, update this file first, then proceed
