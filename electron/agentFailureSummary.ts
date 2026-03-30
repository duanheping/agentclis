const QUOTA_FAILURE_PATTERNS = [
  /\blimit exceed(?:ed)?\b/iu,
  /\bquota(?:\s+exceeded|\s+exhausted)?\b/iu,
  /\brate[- ]?limit(?:ed)?\b/iu,
  /额度用完了/u,
  /配额.*用完/u,
] as const

function normalizeLabel(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return 'Agent'
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

export function detectQuotaFailure(value: string): boolean {
  const normalized = value.trim()
  if (!normalized) {
    return false
  }

  return QUOTA_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function buildQuotaFailureSummary(agentLabel: string): string {
  return `${normalizeLabel(agentLabel)} quota exceeded during structured analysis. Retry later or switch agents.`
}
