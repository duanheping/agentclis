// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  ProjectLocation,
  TranscriptEvent,
} from '../src/shared/projectMemory'
import type { ProjectConfig, SessionConfig } from '../src/shared/session'
import { ProjectMemoryManager } from './projectMemoryManager'

const tempRoots: string[] = []

function buildProject(): ProjectConfig {
  return {
    id: 'project-1',
    title: 'agenclis',
    rootPath: 'C:\\repo\\agenclis',
    createdAt: '2026-03-22T12:00:00.000Z',
    updatedAt: '2026-03-22T12:00:00.000Z',
    primaryLocationId: 'location-1',
    identity: {
      repoRoot: 'C:\\repo\\agenclis',
      gitCommonDir: 'C:\\repo\\agenclis\\.git',
      remoteFingerprint: 'github.com/openai/agenclis',
    },
  }
}

function buildLocation(): ProjectLocation {
  return {
    id: 'location-1',
    projectId: 'project-1',
    rootPath: 'C:\\repo\\agenclis',
    repoRoot: 'C:\\repo\\agenclis',
    gitCommonDir: 'C:\\repo\\agenclis\\.git',
    remoteFingerprint: 'github.com/openai/agenclis',
    label: 'agenclis',
    createdAt: '2026-03-22T12:00:00.000Z',
    updatedAt: '2026-03-22T12:00:00.000Z',
    lastSeenAt: '2026-03-22T12:00:00.000Z',
  }
}

function buildSession(): SessionConfig {
  return {
    id: 'session-1',
    projectId: 'project-1',
    locationId: 'location-1',
    title: 'Codex',
    startupCommand: 'codex',
    pendingFirstPromptTitle: false,
    cwd: 'C:\\repo\\agenclis',
    shell: 'pwsh.exe',
    createdAt: '2026-03-22T12:00:00.000Z',
    updatedAt: '2026-03-22T12:00:00.000Z',
  }
}

function buildTranscript(): TranscriptEvent[] {
  return [
    {
      id: 'event-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      locationId: 'location-1',
      timestamp: '2026-03-22T12:00:00.000Z',
      kind: 'input',
      source: 'user',
      chunk: 'Implement project memory',
    },
    {
      id: 'event-2',
      sessionId: 'session-1',
      projectId: 'project-1',
      locationId: 'location-1',
      timestamp: '2026-03-22T12:00:05.000Z',
      kind: 'output',
      source: 'pty',
      chunk: '\u001b[32mPlanning changes\u001b[39m',
    },
  ]
}

describe('ProjectMemoryManager', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true })))
  })

  it('writes canonical memory beneath a dot-prefixed namespace without machine-local paths', async () => {
    const libraryRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-library-'))
    tempRoots.push(libraryRoot)
    const manager = new ProjectMemoryManager(() => libraryRoot, {
      extract: async () => ({
        summary: 'Implemented the project memory pipeline.',
        candidates: [
          {
            kind: 'decision',
            scope: 'project',
            key: 'memory-pipeline',
            content: 'Project memory should be validated before promotion.',
            confidence: 0.92,
            sourceEventIds: ['event-1', 'event-2'],
          },
        ],
      }),
    })

    await manager.captureSession({
      project: buildProject(),
      location: buildLocation(),
      session: buildSession(),
      transcript: buildTranscript(),
    })

    const memoryRoot = path.join(
      libraryRoot,
      '.agenclis-memory',
      'projects',
      'agenclis--project-1',
    )
    await expect(readFile(path.join(memoryRoot, 'memory.md'), 'utf8')).resolves.toContain(
      'Implemented the project memory pipeline.',
    )
    await expect(readFile(path.join(memoryRoot, 'facts.json'), 'utf8')).resolves.toContain(
      'Canonical remote: github.com/openai/agenclis',
    )
    await expect(readFile(path.join(memoryRoot, 'project.json'), 'utf8')).resolves.not.toContain(
      'C:\\repo\\agenclis',
    )
  })

  it('assembles a short bootstrap context from canonical memory files', async () => {
    const libraryRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-library-'))
    tempRoots.push(libraryRoot)
    const manager = new ProjectMemoryManager(() => libraryRoot, {
      extract: async () => ({
        summary: 'Focused on session restore and memory injection.',
        candidates: [
          {
            kind: 'preference',
            scope: 'project',
            key: 'prefer-compact-ui',
            content: 'Prefer conservative UI changes.',
            confidence: 0.88,
            sourceEventIds: ['event-1'],
          },
        ],
      }),
    })

    await manager.captureSession({
      project: buildProject(),
      location: buildLocation(),
      session: buildSession(),
      transcript: buildTranscript(),
    })

    const context = await manager.assembleContext({
      project: buildProject(),
      location: buildLocation(),
      query: 'restore memory',
    })

    expect(context.bootstrapMessage).toContain('Use the project memory for this logical project')
    expect(context.bootstrapMessage).toContain('Current local checkout: agenclis')
    expect(context.fileReferences.every((filePath) => filePath.includes('.agenclis-memory'))).toBe(
      true,
    )
  })
})
