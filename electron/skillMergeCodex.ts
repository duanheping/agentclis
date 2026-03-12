import type { SkillAiMergeProposal, SkillAiMergeReview } from '../src/shared/skills'
import {
  generateSkillMerge,
  reviewSkillMerge,
  type SkillMergeSource,
} from './skillMergeAgent'

export type { SkillMergeSource } from './skillMergeAgent'

export function generateCodexSkillMerge(
  skillName: string,
  sources: SkillMergeSource[],
): Promise<SkillAiMergeProposal> {
  return generateSkillMerge('codex', skillName, sources)
}

export function reviewCodexSkillMerge(
  proposal: SkillAiMergeProposal,
  sources: SkillMergeSource[],
): Promise<SkillAiMergeReview> {
  return reviewSkillMerge('codex', proposal, sources)
}
