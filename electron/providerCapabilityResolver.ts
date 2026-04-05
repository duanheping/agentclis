import type { ProjectMemoryMode } from '../src/shared/session'
import { supportsCodexSessionResume } from './codexCli'
import { supportsCopilotSessionResume } from './copilotCli'

export interface ProviderProjectMemoryCapability {
  provider: 'codex' | 'copilot' | null
  mode: ProjectMemoryMode
  supportsHiddenSessionStart: boolean
  supportsHiddenPromptUpdate: boolean
  fallbackReason: string | null
}

export function resolveProjectMemoryCapability(
  startupCommand: string,
): ProviderProjectMemoryCapability {
  if (supportsCodexSessionResume(startupCommand)) {
    return {
      provider: 'codex',
      mode: 'codex-developer-instructions',
      supportsHiddenSessionStart: true,
      supportsHiddenPromptUpdate: false,
      fallbackReason: null,
    }
  }

  if (supportsCopilotSessionResume(startupCommand)) {
    return {
      provider: 'copilot',
      mode: 'copilot-instructions',
      supportsHiddenSessionStart: true,
      supportsHiddenPromptUpdate: false,
      fallbackReason: null,
    }
  }

  return {
    provider: null,
    mode: 'unsupported',
    supportsHiddenSessionStart: false,
    supportsHiddenPromptUpdate: false,
    fallbackReason:
      'Hidden project memory is currently supported only for Codex and Copilot sessions.',
  }
}
