# Working with Kiro in this repository

`.kiro/` holds the project context used by Kiro, the agent that built the core of RawReader. It is committed on purpose (see the note at the end of `.gitignore`): the specs, steering files and hooks are part of the project, not local editor state.

The directory has three parts:

```
.kiro/
├─ steering/   always-on project rules
├─ specs/      requirements, design and task lists
└─ hooks/      commands Kiro runs after it saves a file
```

## Steering

Steering files are included in every Kiro turn. They are the first thing to read before changing the project, and the first thing to update when a decision changes.

| File | What it covers |
|---|---|
| `.kiro/steering/product.md` | Who the reader is, the core reading flow, the approved phase-1 scope and exclusions, and the product rules (local-first, privacy, UI language, defaults). |
| `.kiro/steering/tech.md` | Stack and versions, dependency and licence policy, the China mirror setup, local development resources, llama-server rules, Electron security rules, commands and coding conventions. |
| `.kiro/steering/structure.md` | The target repository layout, process boundaries, the single source of app identity, test placement, rules for ported LMT code, runtime data locations, and what is not committed. |

How they are used:

- `product.md` answers "should this exist?" and "what is out of scope?". Do not reopen the approved phase-1 scope without an explicit decision.
- `tech.md` answers "which library, which version, which mirror, which security setting?". A new production dependency must pass its licence allowlist and be added to `THIRD_PARTY_NOTICES.md` in the same change.
- `structure.md` answers "where does this file go?". Keep `src/shared` free of Electron and Node-only APIs, keep Electron side effects at the edges, and colocate unit tests as `*.test.ts`.

All three files start with `inclusion: always` in their frontmatter, which is what makes Kiro load them automatically.

## Specs

Specs are the written plan for the product. They are not generated documentation; they are edited as the work progresses.

### `.kiro/specs/module-plan/module-plan.md`

The source of truth for module choices. It maps each area (browser and capture, detection, OCR, translation, overlay, cache, packaging and so on) to a library, a port source or a "write it ourselves" verdict, with licence and AGPL compatibility notes. When a dependency question is not answered by `tech.md`, it is answered here.

### `.kiro/specs/phase1-mvp/`

The phase-1 specification, in three files:

| File | Contents |
|---|---|
| `requirements.md` | Numbered requirements (R1, R2, …) written in EARS form, with a glossary for terms such as shell, browse view, unit and content hash. |
| `design.md` | The architecture that implements those requirements: process layout, window and browse view, capture order, pipeline states, configuration, cache, shutdown, and the reasoning behind each choice. Module references point back to `module-plan.md`. |
| `tasks.md` | The implementation checklist. Tasks carry requirement and design references, are grouped into slices, and are marked done only when their check passes and `npm run typecheck`, `npm test` and `npm run build` still pass. |

How they are used:

1. Read `requirements.md` to find the requirement that the change serves.
2. Read the matching section of `design.md` before writing code; it usually names the module boundary, the failure behaviour and the test seam.
3. Update `tasks.md` in the same change: tick the task, and add a new task when the work was not planned.
4. If the design changes, edit `design.md`. Do not leave the implementation and the spec describing different systems.

Requirements use EARS patterns ("WHEN … THE SYSTEM SHALL …", "IF … THEN …") so that each line can be turned into a test. Keep that style when adding requirements.

## Hooks

Hooks are command hooks that Kiro runs after it saves a file. They are defined in `.kiro/hooks/` in the standalone `version: "v1"` format, with one or more entries under `hooks[]`. They run from the repository root.

| File | Trigger | Matcher | Command | Timeout | Enabled |
|---|---|---|---|---|---|
| `.kiro/hooks/typecheck-on-save.json` | `PostFileSave` | `src[\\/].*\.(ts|svelte)$` | `npm run typecheck` | 180 | `true` |
| `.kiro/hooks/test-on-save.json` | `PostFileSave` | `\.test\.ts$` | `npm test` | 180 | `true` |

Both are command hooks. They do not inject a prompt, do not start an agent turn and do not use credits. Their output is added to the agent context. A non-zero exit is reported to the agent with the command's stderr. File triggers fire only for files the agent saves, not for manual editor saves.

`.kiro/hooks/README.md` is the human-readable companion to these files and must stay in sync with them. When adding a hook:

- Add the entry to the JSON file and the row to `README.md` with its trigger, matcher, action, timeout and whether it injects an agent prompt.
- A hook that injects a prompt (`"action": { "type": "agent" }`) must say so in the table and should ship with `"enabled": false` until it is needed.
- During a large batch of edits, disable the hooks: use the eye icon in the Kiro Agent Hooks panel, or set `"enabled": false` in the JSON and set it back afterwards. Typecheck takes several seconds, so leaving it on for every save slows bulk work.

## How the work is divided

The project was built by two agents, and the split is deliberate:

- **Kiro** implements the core product: the app shell, browse view and capture, the detection/OCR/translation pipeline, the model manager, configuration, the overlay, packaging, and the specifications and steering files that describe them. Its commits use the `[kiro]` prefix.
- **CodeBuddy / WorkBuddy** handle tests and chores: test fixtures and test-only edits, documentation, repository housekeeping, and verification runs. Their commits use the `[workbuddy]` prefix.
- Occasionally a change is written by CodeBuddy and reviewed by Kiro before it lands. Those commits record that in the subject, for example with a `(CodeBuddy, reviewed)` suffix.

This document describes that division as it is practised in the repository. It is not a rule about who may touch which file: either agent can edit anything, but the review expectation above applies to changes in the core pipeline.

## Adding to `.kiro/`

- Put new rules in the existing steering file that owns the topic. Do not create a fourth always-on file for a one-off note.
- Put new requirements in `requirements.md`, the matching design in `design.md`, and the work item in `tasks.md`.
- Put new reference material that is not a rule and not a plan under `.kiro/specs/` in its own folder, and link it from the spec that uses it.
- Keep every hook listed in `.kiro/hooks/README.md`.
