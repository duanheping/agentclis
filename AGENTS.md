# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the React renderer. Use `src/components/` for UI, `src/store/` for Zustand state, `src/lib/` for renderer-side helpers, and `src/shared/` for types and IPC contracts shared with Electron. Keep test setup in `src/test/setup.ts`.

`electron/` contains the main process, preload bridge, and Windows-specific services such as session management, project tools, worktree handling, and CLI integrations. Static assets live in `public/`. Build output is generated into `dist/`, `dist-electron/`, and `release/`; do not edit generated files directly.

## Build, Test, and Development Commands
`npm install` installs dependencies from `package-lock.json`.

`npm run dev` starts the Vite renderer workflow used during local Electron development.

`npm run lint` runs ESLint across all `ts` and `tsx` files.

`npm test` runs the Vitest suite once. `npm run test:watch` keeps Vitest running while you iterate.

`npm run build` runs `tsc -b` and produces production bundles. `npm run dist` packages the Windows installer into `release/`.

`npm run rebuild` rebuilds `node-pty` if native binaries drift; this requires Visual Studio Build Tools on Windows.

## Coding Style & Naming Conventions
Follow the existing TypeScript style: 2-space indentation, single quotes, trailing commas, and no semicolons. Components and classes use PascalCase, for example `CreateSessionDialog.tsx` and `SessionManager.ts`. Hooks, stores, and utility modules use camelCase, for example `useSessionsStore.ts` and `terminalRegistry.ts`.

Keep renderer and Electron contracts in `src/shared/` instead of duplicating types. Run `npm run lint` before submitting changes.

## Testing Guidelines
Tests are colocated with implementation as `*.test.ts` and `*.test.tsx` in both `src/` and `electron/`. Renderer tests use Vitest with Testing Library and the shared setup in `src/test/setup.ts`; main-process modules use Vitest directly.

Add tests for new behavior and regressions, especially around session lifecycle, IPC boundaries, worktrees, and Windows shell behavior. No coverage threshold is configured, so use changed-code coverage as the baseline.

## Commit & Pull Request Guidelines
Recent history favors concise conventional subjects such as `feat: ...`, `refactor: ...`, `ui: ...`, or scoped fixes like `fix/...: ...`. Keep subjects imperative and focused, and include issue references when relevant, for example `(#36)`.

Pull requests should summarize user-visible impact, mention any Windows-specific behavior, list validation performed (`npm run lint`, `npm test`), and include screenshots or recordings for UI changes.
