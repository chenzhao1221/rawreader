# Kiro hooks

Hook files use the standalone format (`version: "v1"`, one or more entries in `hooks[]`). Kiro runs them from the repository root. File triggers fire only for files the agent saves, not for manual editor saves.

| File | Trigger | Matcher (regex on file path) | Action | Injects a prompt into the agent? |
|---|---|---|---|---|
| `typecheck-on-save.json` | `PostFileSave` | `src[\\/].*\.(ts\|svelte)$` | `npm run typecheck` | No. Shell command only. Its output is added to the agent context. |
| `test-on-save.json` | `PostFileSave` | `\.test\.ts$` | `npm test` | No. Shell command only. Its output is added to the agent context. |

Both hooks are command hooks. They use no credits and start no agent turn. If a command exits non-zero, Kiro reports its stderr to the agent.

## Disable during bulk implementation

Typecheck takes several seconds, so during a large batch of edits turn the hooks off:

- In the Kiro IDE: open the Agent Hooks panel and click the eye icon next to the hook.
- Or edit the JSON file and set `"enabled": false` on the hook. Set it back to `true` to re-enable.

Any future hook that injects an agent prompt (`"action": { "type": "agent" }`) must be added to the table above with "Yes" in the last column, and should ship with `"enabled": false` until it is needed.
