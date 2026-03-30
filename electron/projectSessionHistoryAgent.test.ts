// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { ProjectConfig, SessionConfig } from '../src/shared/session'
import { buildPrompt } from './projectSessionHistoryAgent'

function buildProject(): ProjectConfig {
  return {
    id: 'project-1',
    title: 'agentclis',
    rootPath: 'C:\\repo\\agentclis',
    createdAt: '2026-03-28T12:00:00.000Z',
    updatedAt: '2026-03-28T12:00:00.000Z',
    primaryLocationId: 'location-1',
    identity: {
      repoRoot: 'C:\\repo\\agentclis',
      gitCommonDir: 'C:\\repo\\agentclis\\.git',
      remoteFingerprint: 'github.com/openai/agentclis',
    },
  }
}

function buildSession(id: string, title: string): SessionConfig {
  return {
    id,
    projectId: 'project-1',
    locationId: 'location-1',
    title,
    startupCommand: 'codex',
    pendingFirstPromptTitle: false,
    cwd: 'C:\\repo\\agentclis',
    shell: 'pwsh.exe',
    createdAt: '2026-03-28T12:00:00.000Z',
    updatedAt: '2026-03-28T12:00:00.000Z',
  }
}

describe('projectSessionHistoryAgent buildPrompt', () => {
  it('includes high-signal per-session evidence and tool-choice convergence guidance', () => {
    const prompt = buildPrompt({
      project: buildProject(),
      canonicalMemoryDirectory:
        'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agentclis',
      transcriptBaseRoot: 'C:\\transcripts',
      sessions: [
        {
          session: buildSession('session-1', 'Create PR flow'),
          location: {
            id: 'location-1',
            projectId: 'project-1',
            rootPath: 'C:\\repo\\agentclis',
            repoRoot: 'C:\\repo\\agentclis',
            gitCommonDir: 'C:\\repo\\agentclis\\.git',
            remoteFingerprint: 'github.com/openai/agentclis',
            label: 'agentclis',
            createdAt: '2026-03-28T12:00:00.000Z',
            updatedAt: '2026-03-28T12:00:00.000Z',
            lastSeenAt: '2026-03-28T12:00:00.000Z',
          },
          transcriptEventCount: 120,
          lastTranscriptEventAt: '2026-03-28T12:10:00.000Z',
          transcriptPath: 'C:\\transcripts\\session-1.jsonl',
          transcriptIndexPath: 'C:\\transcripts\\session-1.index.json',
        },
      ],
      agentsExcerpt: 'AGENTS.md\nKeep answers concise.',
      readmeExcerpt: 'README.md\nElectron + React app.',
      skillGuidance: 'Capture user corrections aggressively.',
      sessionEvidenceCatalog: [
        '- session-1 | title="Create PR flow" | location=agentclis | updatedAt=2026-03-28T12:00:00.000Z | events=120 | transcript=session-1.jsonl',
        '  High-signal evidence from across the session:',
        '  - event-17 input/user: Prefer the GitHub REST API instead of gh CLI or MCP for PR creation.',
      ].join('\n'),
    })

    expect(prompt).toContain('High-signal transcript evidence by session:')
    expect(prompt).toContain('Prefer the GitHub REST API instead of gh CLI or MCP for PR creation.')
    expect(prompt).toContain('When several sessions show failed approaches converging on one successful method')
    expect(prompt).toContain('It is valid to preserve a durable tool-choice preference or workflow')
  })
})
