// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { TranscriptEvent } from '../src/shared/projectMemory'
import { buildTranscriptEvidenceDigest } from './projectMemoryEvidence'

function buildEvent(
  id: string,
  kind: TranscriptEvent['kind'],
  source: TranscriptEvent['source'],
  chunk: string,
): TranscriptEvent {
  return {
    id,
    sessionId: 'session-1',
    projectId: 'project-1',
    locationId: 'location-1',
    timestamp: '2026-03-28T12:00:00.000Z',
    kind,
    source,
    chunk,
  }
}

describe('buildTranscriptEvidenceDigest', () => {
  it('keeps decisive corrections and durable workflows from across the transcript', () => {
    const transcript: TranscriptEvent[] = [
      buildEvent('event-1', 'input', 'user', 'Please create the PR end to end.'),
      buildEvent('event-2', 'output', 'pty', 'ok'),
      buildEvent(
        'event-3',
        'input',
        'user',
        'Do not keep retrying gh CLI or MCP for PR creation. Prefer the GitHub REST API: POST /repos/{owner}/{repo}/pulls, then PUT /repos/{owner}/{repo}/pulls/{number}/merge.',
      ),
      buildEvent(
        'event-4',
        'output',
        'pty',
        'The working path is the REST API rather than gh CLI because gh may be missing and MCP may be read-only.',
      ),
      buildEvent('event-5', 'input', 'user', 'Use the final successful method by default next time.'),
    ]

    const digest = buildTranscriptEvidenceDigest(transcript, 4_000, 4)

    expect(digest).toContain('First user request: Please create the PR end to end.')
    expect(digest).toContain('Latest user request: Use the final successful method by default next time.')
    expect(digest).toContain('event-3 input/user')
    expect(digest).toContain('POST /repos/{owner}/{repo}/pulls')
    expect(digest).toContain('REST API rather than gh CLI')
    expect(digest).not.toContain('ok')
  })
})
