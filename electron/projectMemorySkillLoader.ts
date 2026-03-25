import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type ProjectMemorySkillName =
  | 'project-memory-architecture-analysis'
  | 'project-memory-sessions-analysis'

export interface LoadedProjectMemorySkill {
  directory: string
  markdown: string
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory()
  } catch {
    return false
  }
}

async function resolveSkillRoot(): Promise<string | null> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const bundledRoot = path.resolve(
    __dirname,
    '../dist/project-memory-skills',
  )
  if (await directoryExists(bundledRoot)) {
    return bundledRoot
  }

  const publicRoot = path.resolve(process.cwd(), 'public/project-memory-skills')
  if (await directoryExists(publicRoot)) {
    return publicRoot
  }

  return null
}

export async function loadProjectMemorySkill(
  skillName: ProjectMemorySkillName,
): Promise<LoadedProjectMemorySkill | null> {
  const skillRoot = await resolveSkillRoot()
  if (!skillRoot) {
    return null
  }

  const directory = path.join(skillRoot, skillName)

  try {
    const markdown = await readFile(path.join(directory, 'SKILL.md'), 'utf8')
    return {
      directory,
      markdown: markdown.trim(),
    }
  } catch {
    return null
  }
}
