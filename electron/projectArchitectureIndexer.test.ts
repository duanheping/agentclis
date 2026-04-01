// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { indexProjectArchitecture } from './projectArchitectureIndexer'

const tempRoots: string[] = []

async function createFixture(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-arch-index-'))
  tempRoots.push(repoRoot)

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const filePath = path.join(repoRoot, relativePath)
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, content, 'utf8')
    }),
  )

  return repoRoot
}

async function createElectronArchitectureFixture(): Promise<string> {
  return await createFixture({
    'src/App.tsx':
      "import { SessionSidebar } from './components/SessionSidebar'\nimport { TerminalWorkspace } from './components/TerminalWorkspace'\nimport { useSessionsStore } from './store/useSessionsStore'\nexport default function App() { return SessionSidebar && TerminalWorkspace && useSessionsStore ? null : null }\n",
    'src/App.test.tsx': 'export {}\n',
    'src/components/SessionSidebar.tsx': 'export function SessionSidebar() { return null }\n',
    'src/components/SessionSidebar.test.tsx': 'export {}\n',
    'src/components/TerminalWorkspace.tsx': 'export function TerminalWorkspace() { return null }\n',
    'src/components/TerminalWorkspace.test.tsx': 'export {}\n',
    'src/store/useSessionsStore.ts': 'export const useSessionsStore = {}\n',
    'src/shared/ipc.ts': 'export const IPC_CHANNELS = {}\nexport interface AgentCliApi {}\n',
    'src/shared/session.ts': 'export interface SessionConfig {}\nexport function buildRuntime() { return null }\n',
    'src/shared/projectMemory.ts': 'export interface AssembledProjectContext {}\n',
    'src/shared/projectArchitecture.ts': 'export interface ProjectArchitectureSnapshot {}\n',
    'electron/preload.ts':
      "import { IPC_CHANNELS } from '../src/shared/ipc'\nexport const api = { IPC_CHANNELS }\n",
    'electron/main.ts':
      "import { IPC_CHANNELS } from '../src/shared/ipc'\nimport { SessionManager } from './sessionManager'\nimport { ProjectMemoryService } from './projectMemoryService'\nimport { SkillLibraryManager } from './skillLibraryManager'\nexport function registerIpcHandlers() { return { IPC_CHANNELS, SessionManager, ProjectMemoryService, SkillLibraryManager } }\n",
    'electron/sessionManager.ts':
      "import { TranscriptStore } from './transcriptStore'\nimport { ProjectMemoryService } from './projectMemoryService'\nexport class SessionManager { transcriptStore?: TranscriptStore; projectMemory?: ProjectMemoryService }\n",
    'electron/sessionManager.test.ts': 'export {}\n',
    'electron/transcriptStore.ts': 'export class TranscriptStore {}\n',
    'electron/transcriptStore.test.ts': 'export {}\n',
    'electron/projectMemoryService.ts':
      "import { ProjectMemoryManager } from './projectMemoryManager'\nexport class ProjectMemoryService { manager?: ProjectMemoryManager }\n",
    'electron/projectMemoryService.test.ts': 'export {}\n',
    'electron/projectMemoryManager.ts':
      "import { ProjectMemoryAgentExtractor } from './projectMemoryAgent'\nexport class ProjectMemoryManager { extractor?: ProjectMemoryAgentExtractor }\n",
    'electron/projectMemoryManager.test.ts': 'export {}\n',
    'electron/projectMemoryAgent.ts': 'export class ProjectMemoryAgentExtractor {}\n',
    'electron/projectMemoryAgent.test.ts': 'export {}\n',
    'electron/skillLibraryManager.ts': 'export class SkillLibraryManager {}\n',
    'electron/skillLibraryManager.test.ts': 'export {}\n',
    'electron/windowsCommandPromptManager.ts': 'export class WindowsCommandPromptManager {}\n',
  })
}

async function createDocumentedArchitectureFixture(): Promise<string> {
  return await createFixture({
    'docs/architecture.md': `# Platform Architecture

The platform is split into an API layer, a background job runner, and a durable storage boundary.

## API Layer

Accepts external requests, validates them, and maps them into internal jobs.

## Job Runner

Owns asynchronous processing and scheduled execution of queued work.

## Storage

Persists durable state, history, and job progress for later reads and retries.
`,
    'services/api/index.ts': 'export const api = true\n',
    'workers/job/index.ts': 'export const jobRunner = true\n',
    'package.json': '{ "name": "documented-repo" }\n',
  })
}

async function createAutosarArchitectureFixture(): Promise<string> {
  return await createFixture({
    'Applications/SipAddon/StartApplication/Appl/ECG2_VMCU.bat': '@echo off\n',
    'Applications/SipAddon/StartApplication/Appl/ECG2_VMCU.gpj': 'project ECG2_VMCU\n',
    'Applications/SipAddon/StartApplication/Appl/Source/Vmcu/VmcuToken.c': 'void VmcuToken(void) {}\n',
    'Applications/SipAddon/StartApplication/Appl/Source/Diag/DiagInboundApp.c': 'void DiagInboundApp(void) {}\n',
    'Applications/SipAddon/StartApplication/Appl/Source/Wm/Wm.c': 'void Wm(void) {}\n',
    'Applications/SipAddon/StartApplication/Appl/Source/Can/CanTpWrapper.c': 'void CanTpWrapper(void) {}\n',
    'Applications/SipAddon/StartApplication/Appl/Source/Ipc_Hal/Uart/UartIpc.c': 'void UartIpc(void) {}\n',
    'Applications/SipAddon/StartApplication/Appl/Source/Cdd/UartCdd.c': 'void UartCdd(void) {}\n',
    'Applications/SipAddon/StartApplication/Appl/Source/Flash/OTA_Flash.c': 'void OTA_Flash(void) {}\n',
    'Applications/SipAddon/StartApplication/Appl/Source/hse_driver/hse_comm.c': 'void hse_comm(void) {}\n',
    'Applications/SipAddon/StartApplication/Appl/Include/Vmcu/VmcuToken.h': 'void VmcuToken(void);\n',
    'Applications/SipAddon/StartApplication/Appl/GenData_P708_MY23/Rte.c': 'void Rte_Start(void) {}\n',
    'Applications/SipAddon/StartApplication/Appl/GenData_CX727_MY26_BEV/Rte.c': 'void Rte_Start(void) {}\n',
    'Applications/SipAddon/StartApplication/Appl/ECG2_VMCU_P708_MY23/build.log': 'ok\n',
    'Applications/SipAddon/StartApplication/Appl/ECG2_VMCU_CX727_MY26_BEV/build.log': 'ok\n',
    'Applications/SipAddon/StartApplication/Config_P708_MY23/ECUC/Can_ecuc.arxml': '<AUTOSAR></AUTOSAR>\n',
    'Applications/SipAddon/StartApplication/Config_CX727_MY26_BEV/ECUC/Wm_ecuc.arxml': '<AUTOSAR></AUTOSAR>\n',
    'Applications/SipAddon/StartApplication/ECG_CAN_ETH_P708_MY23.dpa': '<dpa />\n',
    'Applications/SipAddon/StartApplication/ECG_CAN_ETH_CX727_MY26_BEV.dpa': '<dpa />\n',
    'BSW/BswInit.c': 'void BswInit(void) {}\n',
    'BSWMD/BswInit.arxml': '<ECUC></ECUC>\n',
    'DaVinciConfigurator/project.dpa': '<dpa />\n',
    'Generators/generate.bat': '@echo off\n',
    'vpconfig/variant.ecuc.arxml': '<AUTOSAR></AUTOSAR>\n',
    'unit_test/test_BswInit.c': 'void test_BswInit(void) {}\n',
    'unit_test/UnitTest_ECG2_Diag/test/test_diag.c': 'void test_diag(void) {}\n',
    'unit_test/UnitTest_Wm/test/test_wm.c': 'void test_wm(void) {}\n',
    'Tools/helper.ps1': 'Write-Host test\n',
    'ThirdParty/vector/lib.c': 'void lib(void) {}\n',
    'README.md': 'AUTOSAR ECU repository for generated BSW, variant configuration, and VMCU application integration.\n',
  })
}

async function createGenericArchitectureFixture(): Promise<string> {
  return await createFixture({
    'packages/core/index.ts': 'export const core = true\n',
    'scripts/build.mjs': 'export default true\n',
    'tests/core.test.ts': 'export {}\n',
    'package.json': '{ "name": "generic-repo" }\n',
    'README.md': 'This repo contains reusable packages plus scripts and tests.\n',
  })
}

describe('projectArchitectureIndexer', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) =>
        rm(tempRoot, { recursive: true, force: true }),
      ),
    )
  })

  it('indexes module cards and interactions from an Electron repo-like layout', async () => {
    const repoRoot = await createElectronArchitectureFixture()

    const snapshot = await indexProjectArchitecture({
      projectId: 'remote-github.com-openai-agenclis',
      title: 'agenclis',
      rootPath: repoRoot,
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot?.systemOverview).toContain('React renderer')
    expect(snapshot?.modules.map((module) => module.id)).toEqual(
      expect.arrayContaining([
        'renderer-app-shell',
        'preload-bridge',
        'main-process-composition-root',
        'session-lifecycle-manager',
        'project-memory-queue',
        'project-memory-canonical-store',
      ]),
    )

    const rendererModule = snapshot?.modules.find(
      (module) => module.id === 'renderer-app-shell',
    )
    expect(rendererModule?.paths).toEqual(['src/App.tsx'])
    expect(rendererModule?.dependsOn).toEqual(
      expect.arrayContaining([
        'session-sidebar',
        'terminal-workspace',
        'renderer-session-store',
      ]),
    )

    const sharedContracts = snapshot?.modules.find(
      (module) => module.id === 'shared-contracts',
    )
    expect(sharedContracts?.publicInterfaces).toContain('IPC_CHANNELS')
    expect(sharedContracts?.paths.every((repoPath) => !repoPath.includes('\\'))).toBe(
      true,
    )

    expect(snapshot?.interactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'renderer-to-preload',
          via: 'window.agentCli',
        }),
        expect.objectContaining({
          id: 'session-to-project-memory-queue',
        }),
      ]),
    )
  })

  it('prefers dedicated architecture documents when they exist', async () => {
    const repoRoot = await createDocumentedArchitectureFixture()

    const snapshot = await indexProjectArchitecture({
      projectId: 'remote-github.com-example-documented',
      title: 'documented',
      rootPath: repoRoot,
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot?.systemOverview).toContain('docs/architecture.md')
    expect(snapshot?.modules.map((module) => module.name)).toEqual(
      expect.arrayContaining(['API Layer', 'Job Runner', 'Storage']),
    )
    expect(snapshot?.modules.every((module) => module.paths[0] === 'docs/architecture.md')).toBe(
      true,
    )
    expect(snapshot?.glossary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          term: 'architecture source',
        }),
      ]),
    )
  })

  it('detects AUTOSAR-style repositories and builds a structural snapshot', async () => {
    const repoRoot = await createAutosarArchitectureFixture()

    const snapshot = await indexProjectArchitecture({
      projectId: 'remote-github.com-ford-ecg-msar43_s32g',
      title: 'msar43_s32g',
      rootPath: repoRoot,
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot?.systemOverview).toContain('ECG2_VMCU.bat')
    expect(snapshot?.systemOverview).toContain('Detected 2 variant-specific')
    expect(snapshot?.modules.map((module) => module.id)).toEqual(
      expect.arrayContaining([
        'autosar-build-entrypoints',
        'autosar-variant-layout',
        'autosar-user-source-root',
        'autosar-generated-platform',
        'autosar-diagnostics',
        'autosar-wake-management',
      ]),
    )
    expect(
      snapshot?.modules.find((module) => module.id === 'autosar-build-entrypoints')?.paths,
    ).toEqual(
      expect.arrayContaining([
        'Applications/SipAddon/StartApplication/Appl/ECG2_VMCU.bat',
        'Applications/SipAddon/StartApplication/Appl/ECG2_VMCU.gpj',
      ]),
    )
    expect(
      snapshot?.modules.find((module) => module.id === 'autosar-variant-layout')?.paths,
    ).toEqual(
      expect.arrayContaining([
        'Applications/SipAddon/StartApplication/Config_P708_MY23',
        'Applications/SipAddon/StartApplication/Config_CX727_MY26_BEV',
      ]),
    )
    expect(
      snapshot?.modules.find((module) => module.id === 'autosar-user-source-root')?.paths,
    ).toEqual(
      expect.arrayContaining([
        'Applications/SipAddon/StartApplication/Appl/Source',
      ]),
    )
    expect(snapshot?.interactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'autosar-variant-to-build',
        }),
        expect.objectContaining({
          id: 'autosar-user-to-platform',
        }),
      ]),
    )
    expect(snapshot?.glossary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          term: 'Config_<VARIANT>',
        }),
      ]),
    )
  })

  it('falls back to a generic structural snapshot for unknown repository shapes', async () => {
    const repoRoot = await createGenericArchitectureFixture()

    const snapshot = await indexProjectArchitecture({
      projectId: 'remote-github.com-example-generic',
      title: 'generic',
      rootPath: repoRoot,
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot?.systemOverview).toContain('Structural snapshot')
    expect(snapshot?.modules.map((module) => module.name)).toEqual(
      expect.arrayContaining(['Packages', 'Scripts', 'Tests']),
    )
    expect(snapshot?.glossary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          term: 'structural snapshot',
        }),
      ]),
    )
    expect(snapshot?.interactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'generic-tests-to-primary',
        }),
      ]),
    )
  })
})
