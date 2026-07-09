const CLASSIC_GITHUB_PAT_PREFIX = 'ghp_'
const COPILOT_GITHUB_TOKEN_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN'] as const

export function isClassicGitHubPersonalAccessToken(
  value: string | undefined,
): boolean {
  return typeof value === 'string' && value.startsWith(CLASSIC_GITHUB_PAT_PREFIX)
}

export function withoutClassicGitHubTokensForCopilot(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = { ...env }

  for (const key of COPILOT_GITHUB_TOKEN_KEYS) {
    if (isClassicGitHubPersonalAccessToken(sanitized[key])) {
      delete sanitized[key]
    }
  }

  return sanitized
}

export function buildUnsetClassicGitHubTokensPowerShellLines(): string[] {
  return COPILOT_GITHUB_TOKEN_KEYS.map(
    (key) =>
      `if ($env:${key} -like 'ghp_*') { Remove-Item Env:${key} -ErrorAction SilentlyContinue }`,
  )
}
