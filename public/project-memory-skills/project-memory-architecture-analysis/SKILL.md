---
name: project-memory-architecture-analysis
description: Analyze a repository's architecture for Agent CLIs project memory. Use when a primary agent needs to synthesize durable architecture docs, module boundaries, interactions, invariants, and critical files for a logical project.
---

# Architecture Analysis

Inspect the repository directly before trusting heuristics or precomputed summaries.

Use this workflow:

1. Read the strongest repo-local guidance first.
   Prefer `architecture.md`, `ARCHITECTURE.md`, `AGENTS.md`, and `README.md` when present.
2. Confirm the architecture from real code before writing it down.
   Open the main entry points, state owners, IPC boundaries, service layers, and the files that actually coordinate lifecycle or cross-process behavior.
3. Prefer control flow and ownership over folder listing.
   Explain where state lives, who starts work, who transforms data, who persists it, and where user actions cross boundaries.
4. Name modules the way the repo names them.
   Reuse concrete file, feature, and subsystem names from the codebase instead of generic labels like "backend layer" when a stronger local name exists.
5. Keep the output durable.
   Prefer stable subsystems, contracts, and edit boundaries over ticket-specific changes or temporary implementation details.
6. Use tests and shared contracts as evidence.
   If a boundary or invariant is unclear, inspect tests and shared type definitions before claiming how it works.
7. Omit weak claims.
   If the evidence is thin, return fewer modules or interactions rather than inventing structure.
8. For embedded or AUTOSAR-style repositories, cover the operational shape explicitly.
   Identify the concrete build entrypoints, variant layout, generated-code boundaries, third-party/vendor areas, and user-owned source areas with relative paths.
9. For AUTOSAR/MSAR repositories, do not stop at top-level labels such as `Applications/` or `BSW/`.
   Explain where variants live, how many are present when that can be verified, where generated code lands, and where feature code should be edited instead.
10. Prefer user-code modules over abstract umbrellas.
   If the repo exposes concrete application domains such as diagnostics, wake management, CAN, IPC, or framework utilities, name those modules and explain how they interact.

Quality bar:

- Prefer relative repo paths.
- Read enough source to explain actual runtime behavior, not just static structure.
- Highlight files to read first when changing behavior.
- Explain where state is owned and how work moves between components.
- Keep invariants actionable for a future agent editing this repo.
- Prefer a small set of strong modules with clear responsibilities over many shallow modules.
- For AUTOSAR/MSAR repos, include:
  - build script / project file paths
  - variant config and generated-code paths
  - user-owned vs generated vs third-party boundaries
  - concrete source-module paths for the main user logic
- Do not repeat temporary implementation status, open tasks, or session-specific progress.
