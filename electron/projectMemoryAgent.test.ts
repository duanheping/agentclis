// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { TranscriptEvent } from '../src/shared/projectMemory'
import type { ProjectConfig, SessionConfig } from '../src/shared/session'
import {
  buildPrompt,
  MAX_PROJECT_MEMORY_PROMPT_BYTES,
  parseProjectMemoryResponse,
} from './projectMemoryAgent'

describe('parseProjectMemoryResponse', () => {
  it('drops malformed candidates that do not match the allowed enums and scalar types', () => {
    const parsed = parseProjectMemoryResponse(
      JSON.stringify({
        summary: 'Stable summary',
        candidates: [
          {
            kind: 'fact',
            scope: 'project',
            key: 'preferred-shell',
            content: 'Prefer PowerShell over cmd.',
            confidence: 0.91,
            sourceEventIds: ['event-1'],
          },
          {
            kind: 'invalid-kind',
            scope: 'project',
            key: 'bad-kind',
            content: 'Should be ignored.',
            confidence: 0.7,
            sourceEventIds: ['event-2'],
          },
          {
            kind: 'workflow',
            scope: 'invalid-scope',
            key: 'bad-scope',
            content: 'Should also be ignored.',
            confidence: 0.8,
            sourceEventIds: ['event-3'],
          },
          {
            kind: 'decision',
            scope: 'project',
            key: 'bad-confidence',
            content: 'Wrong confidence type.',
            confidence: '0.8',
            sourceEventIds: ['event-4'],
          },
        ],
      }),
    )

    expect(parsed).toEqual({
      summary: 'Stable summary',
      candidates: [
        {
          kind: 'fact',
          scope: 'project',
          key: 'preferred-shell',
          content: 'Prefer PowerShell over cmd.',
          confidence: 0.91,
          sourceEventIds: ['event-1'],
        },
      ],
    })
  })
})

describe('buildPrompt', () => {
  it('keeps oversized transcripts below the codex input limit while preserving recent context', () => {
    const transcript: TranscriptEvent[] = Array.from({ length: 1_200 }, (_, index) => ({
      id: `event-${index}`,
      sessionId: 'session-1',
      projectId: 'project-1',
      locationId: 'location-1',
      timestamp: '2026-03-22T12:00:00.000Z',
      kind: index % 2 === 0 ? 'output' : 'input',
      source: index % 2 === 0 ? 'pty' : 'user',
      chunk: `chunk-${index} ${'x'.repeat(360)}`,
    }))
    const project: ProjectConfig = {
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
    const session: SessionConfig = {
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

    const prompt = buildPrompt({
      project,
      location: {
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
      },
      session,
      transcript,
      normalizedTranscript: transcript
        .map((event) => `[${event.kind}] ${event.chunk}`)
        .join('\n'),
    })

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(
      MAX_PROJECT_MEMORY_PROMPT_BYTES,
    )
    expect(prompt).toContain('event-1199')
    expect(prompt).toContain('[older transcript omitted:')
    expect(prompt).toContain('[older events omitted:')
    expect(prompt).not.toContain('event-0 output/pty')
    expect(prompt).toContain('Do not record ticket-specific progress state such as numbered PRs')
  })

  it('preserves decisive early-session corrections in the prompt evidence digest', () => {
    const transcript: TranscriptEvent[] = [
      {
        id: 'event-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        timestamp: '2026-03-22T12:00:00.000Z',
        kind: 'input',
        source: 'user',
        chunk:
          'Do not keep retrying gh CLI or MCP for PR creation. Use the GitHub REST API instead: POST /repos/{owner}/{repo}/pulls and PUT /repos/{owner}/{repo}/pulls/{number}/merge.',
      },
      ...Array.from({ length: 900 }, (_, index) => ({
        id: `event-${index + 2}`,
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        timestamp: '2026-03-22T12:00:00.000Z',
        kind: index % 2 === 0 ? ('output' as const) : ('input' as const),
        source: index % 2 === 0 ? ('pty' as const) : ('user' as const),
        chunk: `noise-${index} ${'x'.repeat(420)}`,
      })),
    ]
    const project: ProjectConfig = {
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
    const session: SessionConfig = {
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

    const prompt = buildPrompt({
      project,
      location: {
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
      },
      session,
      transcript,
      normalizedTranscript: transcript
        .map((event) => `[${event.kind}] ${event.chunk}`)
        .join('\n'),
    })

    expect(prompt).toContain('High-signal evidence from across the session:')
    expect(prompt).toContain('POST /repos/{owner}/{repo}/pulls')
    expect(prompt).toContain('Use the GitHub REST API instead')
  })
})
