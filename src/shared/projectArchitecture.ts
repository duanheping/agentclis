export const ARCHITECTURE_MODULE_KINDS = [
  'renderer',
  'store',
  'shared-contract',
  'preload-bridge',
  'main-process',
  'service',
  'manager',
  'utility',
] as const

export type ArchitectureModuleKind = (typeof ARCHITECTURE_MODULE_KINDS)[number]

export interface ArchitectureModuleCard {
  id: string
  name: string
  kind: ArchitectureModuleKind
  paths: string[]
  responsibility: string
  owns: string[]
  dependsOn: string[]
  usedBy: string[]
  publicInterfaces: string[]
  keyTypes: string[]
  invariants: string[]
  changeGuidance: string[]
  testLocations: string[]
  confidence: number
}

export interface ArchitectureInteraction {
  id: string
  from: string
  to: string
  via: string
  purpose: string
  trigger: string
  failureModes: string[]
  notes: string[]
}

export interface ArchitectureInvariant {
  id: string
  statement: string
  relatedModules: string[]
}

export interface ArchitectureGlossaryTerm {
  term: string
  meaning: string
}

export interface ProjectArchitectureSnapshot {
  projectId: string
  title: string
  generatedAt: string
  systemOverview: string
  modules: ArchitectureModuleCard[]
  interactions: ArchitectureInteraction[]
  invariants: ArchitectureInvariant[]
  glossary: ArchitectureGlossaryTerm[]
}
