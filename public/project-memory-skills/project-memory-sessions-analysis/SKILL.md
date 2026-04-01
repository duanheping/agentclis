---
name: project-memory-sessions-analysis
description: Analyze all stored Agent CLIs sessions for one logical project and distill durable project memory. Use when a primary agent needs to review many session transcripts together, consolidate repeated lessons, and update canonical memory with high-signal facts, decisions, preferences, workflows, troubleshooting patterns, and critical files.
---

# Sessions Analysis

Review the full stored session set as one project history, not as isolated chats.

Use this workflow:

1. Scan the session catalog first.
   Use titles, timestamps, locations, and transcript sizes to identify the sessions most likely to contain durable project guidance.
2. Read the current canonical memory before adding anything new.
   Treat existing memory files as the baseline to improve, deduplicate, strengthen, or correct.
3. Inspect transcripts selectively but deeply enough.
   Read the sessions that introduced architecture understanding, repeated fixes, durable workflows, user corrections, stable repo conventions, or important debugging approaches.
4. Validate transcript claims against the repository.
   When a transcript implies a stable rule, critical file, or durable workflow, inspect the repo to confirm it before recording it as memory.
5. Consolidate across sessions.
   Merge repeated lessons into one stronger memory item instead of emitting many near-duplicates.
6. Prefer durable memory over historical narration.
   Keep stable facts, chosen approaches, debugging playbooks, user preferences, and critical files. Omit branch history, commit history, PR status, temp paths, and one-off progress updates.
7. Resolve conflicts by preferring verified, current truth.
   If sessions disagree, keep the claim that matches the current codebase or appears repeatedly across sessions with stronger evidence.
8. Capture user corrections aggressively.
   If the user corrected a wrong assumption and that correction is repo-relevant and durable, prefer preserving that lesson over generic implementation notes.
9. Keep one lesson in one category.
   Do not repeat the same file, command, or rule across facts, workflows, conventions, debug approaches, and component workflows unless each entry adds meaning that the others do not.
10. Preserve exact corrected syntax.
   When the user corrected a command, prompt prefix, shell marker, or literal token, keep only the corrected final form and drop the earlier wrong spelling.
11. Treat generic instruction docs carefully.
   Files such as `AGENTS.md`, `README.md`, or `github/copilot-instructions.md` should appear only when they are the authoritative source for a repo-specific rule; prefer code, configs, build scripts, and tests over generic instruction files.

Quality bar:

- Treat the current canonical memory as context to improve, not text to repeat.
- Use relative repo paths, not machine-local paths.
- Emit fewer items when they are higher signal.
- Write each item so a future agent can act on it immediately.
- Prefer memory that explains how to succeed in this repo over summaries of what happened in a past session.
- Top-level memory should stay outline-first: keep long detail in the focused docs, not in repeated generic summaries.
- Do not preserve session-specific titles, shell paths, branch names, commit SHAs, PR numbers, build numbers, or temporary checkout details.
