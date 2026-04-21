<!-- agentclis-project-memory:start -->
Use the project memory for this logical project before proceeding.
Read:
- C:\Users\hduan10\agentclis\.agenclis-memory\projects\remote-github.com-duanheping-agentclis\memory.md
- C:\Users\hduan10\agentclis\.agenclis-memory\projects\remote-github.com-duanheping-agentclis\summaries\latest.md
- C:\Users\hduan10\agentclis\.agenclis-memory\projects\remote-github.com-duanheping-agentclis\sessions-analysis.md
- C:\Users\hduan10\agentclis\.agenclis-memory\projects\remote-github.com-duanheping-agentclis\architecture.md
- C:\Users\hduan10\agentclis\.agenclis-memory\projects\remote-github.com-duanheping-agentclis\architecture.json
- C:\Users\hduan10\agentclis\.agenclis-memory\projects\remote-github.com-duanheping-agentclis\troubleshooting.md
- C:\Users\hduan10\agentclis\.agenclis-memory\projects\remote-github.com-duanheping-agentclis\critical-files.md
Current local checkout: agentclis_3
Latest summary: Short Codex CLI session where the agent explained recent sessionManager.ts changes: async managed-session binding on create and a tightened external-session attention-tracking handoff for empty events.jsonl files. User expressed dissatis...
Historical sessions analysis: Sessions analysis reveals project maturity in terminal management (scrollbar, focus, scrollback), provider-native memory injection replacing command-line injection to avoid Windows limits, EMU-blocked PR workflows requiring REST API with git credential fill...
Architecture overview: Agent CLIs is a Windows Electron desktop application that manages multiple local AI CLI sessions (Codex, Copilot). It is layered into three process boundaries: a React renderer (src/), a preload bridge (electron/preload.ts), and an Electron main process (el...
Troubleshooting patterns:
- Problem: When restoring a managed CLI session (codex or copilot) whose externalSession was never captured (e.g. the session was interrupted before pollForExternalSessionRef detected the CLI's session id), the restore path enters an infinite error loop. Decisive signal: repeated 'Managed codex session "<title>" is missing a stored session id. Create a new session to start over.' errors in the transcript, with runtime cycling starting→error→starting→error. Root cause: restoreSessions() at electron/sessionManager.ts:539 calls scheduleSessionStart() which invokes ensureSessionStarted() → startSession() with default options (no allowManagedSessionBinding). Inside prepareManagedSessionLaunchConfig() at line 1545, when config.externalSession is falsy and allowManagedSessionBinding is not true, it throws. The error handler in startSession() sets status='error' and exitCode=-1 but does NOT remove the session or prevent rescheduling, so the next activation or restore attempt retries and fails identically. Resolution approach: either (a) detect the unrecoverable state in ensureSessionStarted and skip re-launch, or (b) pass allowManagedSessionBinding:true during restore so the CLI can rebind, or (c) mark the session as permanently failed after N consecutive bind failures.
Critical files:
- electron/sessionManager.ts is the central orchestrator for all session lifecycle: create, restore, start, stop, close, restart, worktree setup, managed CLI binding (codex/copilot), external session detection, transcript events, terminal management, and runtime state. It is ~2900+ lines. Key method map: createSession (line ~721), restoreSessions (line ~539), startSession (line ~976), ensureSessionStarted (line ~1183), prepareManagedSessionLaunchConfig (line ~1526), rollbackCreatedSession (line ~2424), closeSession (line ~838). Read this file first for any session lifecycle bug.
Relevant facts:
- Canonical remote: github.com/duanheping/agentclis
- agentclis is a Windows Electron desktop app that manages multiple local agent CLI sessions. Stack: Electron 41, React 19, Zustand 5, xterm.js 6 beta, node-pty 1.x, Vite 7, vitest 4, TypeScript 5.9. Build produces dist/ (renderer) and dist-electron/ (main process). Windows installer via electron-builder NSIS target.
Relevant modules:
- Shared contracts [src/shared/ipc.ts]: Defines all IPC channel names (IPC_CHANNELS), the AgentCliApi interface, and every shared type used across the renderer and main process: session/project/runtime shapes, transcript event kinds, project memory candidate schemas, architecture module cards, skill library types, git diff structures, and session attention classification logic.
- Preload bridge [electron/preload.ts]: Implements the AgentCliApi interface by mapping each method to ipcRenderer.invoke or ipcRenderer.send calls against IPC_CHANNELS. Exposes the API as window.agentCli via contextBridge.exposeInMainWorld. Wraps event listeners (onSessionData, onSessionConfig, onSessionRuntime, onSessionExit, etc.) with unsubscribe handles.
- Main process composition root [electron/main.ts]: Electron main process entry point. Instantiates all service singletons (SessionManager, TranscriptStore, TerminalSnapshotStore, ProjectMemoryService, ProjectMemoryManager, SkillLibraryManager, WindowsCommandPromptManager, TransientFileStore, ProjectIdentityResolver), creates BrowserWindows, registers all IPC handlers in registerIpcHandlers(), manages the analysis terminal window lifecycle, coordinates app lifecycle (single-instance lock, before-quit cleanup, CSP headers), and bridges SessionManager events to the renderer via webContents.send.
Key interactions:
- Renderer app shell -> Preload bridge via window.agentCli method calls and event subscriptions: All renderer actions (create session, write terminal input, open project, sync skills) and event subscriptions (session data/config/runtime/exit) flow through the preload bridge instead of direct Electron IPC access.
- Preload bridge -> Main process composition root via ipcRenderer.invoke/send mapped to ipcMain.handle/on using IPC_CHANNELS: Forwards typed renderer requests to main-process IPC handlers which delegate to the appropriate service singleton.
Treat decisions and preferences as defaults unless the user overrides them.
<!-- agentclis-project-memory:end -->

# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the React renderer. Use `src/components/` for UI, `src/store/` for Zustand state, `src/lib/` for renderer-side helpers, and `src/shared/` for types and IPC contracts shared with Electron. Keep test setup in `src/test/setup.ts`.

`electron/` contains the main process, preload bridge, and Windows-specific services such as session management, project tools, worktree handling, and CLI integrations. Static assets live in `public/`. Build output is generated into `dist/`, `dist-electron/`, and `release/`; do not edit generated files directly.

## Build, Test, and Development Commands
```powershell
npm install          # Install dependencies
npm run dev          # Start Vite renderer for local Electron development
npm run lint         # ESLint across all ts/tsx files
npm test             # Vitest suite once
npm run test:watch   # Vitest in watch mode
npm run build        # tsc -b + production bundles
npm run dist         # Windows installer into release/
npm run rebuild      # Rebuild node-pty native binaries
```

Run a single test file: `npx vitest run src/shared/session.test.ts`

## Coding Style & Naming Conventions
Follow the existing TypeScript style: 2-space indentation, single quotes, trailing commas, and no semicolons. Components and classes use PascalCase (`CreateSessionDialog.tsx`, `SessionManager.ts`). Hooks, stores, and utility modules use camelCase (`useSessionsStore.ts`, `terminalRegistry.ts`).

Keep renderer and Electron contracts in `src/shared/` instead of duplicating types. Run `npm run lint` before submitting changes.

## Testing Guidelines
Tests are colocated with implementation as `*.test.ts` and `*.test.tsx` in both `src/` and `electron/`. Renderer tests use Vitest with Testing Library and the shared setup in `src/test/setup.ts`; main-process modules use Vitest directly.

Add tests for new behavior and regressions, especially around session lifecycle, IPC boundaries, worktrees, and Windows shell behavior.

## Commit & Pull Request Guidelines
Use concise conventional subjects: `feat: ...`, `refactor: ...`, `ui: ...`, or scoped fixes like `fix/...: ...`. Keep subjects imperative and focused, include issue references when relevant (e.g. `(#36)`).

## PR Creation and Merge
Always use the GitHub REST API for creating and merging PRs. Never claim it is impossible or suggest `gh` CLI (it is not installed). Never ask the user to create PRs manually.

```powershell
# Create PR
$headers = @{ Authorization = "token $env:GITHUB_TOKEN"; Accept = "application/vnd.github+json" }
$body = @{ title = "feat: ..."; head = "<branch>"; base = "main"; body = "..." } | ConvertTo-Json
$pr = Invoke-RestMethod -Uri "https://api.github.com/repos/duanheping/agentclis/pulls" -Headers $headers -Method Post -Body $body -ContentType "application/json"

# Squash merge
$merge = @{ merge_method = "squash" } | ConvertTo-Json
Invoke-RestMethod -Uri "https://api.github.com/repos/duanheping/agentclis/pulls/$($pr.number)/merge" -Headers $headers -Method Put -Body $merge -ContentType "application/json"
```

## Windows Command-Line Length Limits
On Windows, command lines exceeding ~8000 characters will fail with `ENAMETOOLONG`. When building complex commands (many `--add-dir` arguments, long file paths, or multi-argument CLI invocations), write the command to a temp `.cmd` or `.ps1` script and execute that script instead of passing everything as a single `spawn` argument. This has caused production bugs in `structuredAgentRunner.ts` and `projectMemoryManager.ts`.

## sessionManager.ts Navigation
`electron/sessionManager.ts` is ~2900 lines and the central orchestrator for all session lifecycle. Always use `view_range` — never read the whole file at once. Key method map:

| Method | ~Line | Purpose |
|--------|-------|---------|
| `restoreSessions` | 539 | Load persisted sessions on startup |
| `createSession` | 721 | Create new session with config |
| `closeSession` | 838 | Stop terminal and clean up |
| `startSession` | 976 | Spawn node-pty, register callbacks |
| `ensureSessionStarted` | 1183 | Guard: start if not running |
| `prepareManagedSessionLaunchConfig` | 1526 | Build codex/copilot CLI command |
| `rollbackCreatedSession` | 2424 | Undo failed session creation |

**Known pitfall:** Terminal `onData`/`onExit` closures must capture an immutable `const sessionId = config.id` — never reference the mutable `normalizedConfig` variable, which gets reassigned 3 times during startup (lines ~615-660). A stale-closure bug here caused cross-session content mixing (PR #66).

## xterm.js v6 Overlay Scrollbar
xterm.js v6 beta uses an overlay scrollbar that defaults to `opacity: 0` (invisible). The project overrides this in `src/App.css` with `.xterm-scrollbar .invisible { opacity: 1 }` plus explicit `scrollbarSliderBackground` theme options in `TerminalWorkspace.tsx` and `AnalysisWindow.tsx`. When adding new terminal components, always include both the CSS override and the theme options.
