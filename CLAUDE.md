# CLAUDE.md

Guidance for AI assistants working on this branch.

## Current work: Simple UI redesign

Branch `feature/simple-ui` builds a simplified, roleplay-focused UI for SillyTavern on top of the native OOC mode from `feature/ooc-mode`. The full design, the decisions the project owner made, the architecture and the details of each task are in [`docs/simple-ui-plan.md`](docs/simple-ui-plan.md). Read it before changing anything. The OOC mode itself is documented in [`docs/ooc-mode-plan.md`](docs/ooc-mode-plan.md).

### Task index

| # | Task | Status |
|---|---|---|
| 1 | Shell and navigation | Done |
| 2 | Settings dialog | Done |
| 3 | Local engine auto-detection | Done |
| 4 | Role styles, per chat | **In review: next task** |
| 5 | Onboarding wizard | Pending |
| 6 | Sweep of drawer openers | Pending |
| 7 | Extensions tab | Pending |
| 8 | Character card and world in the simple UI | Pending |
| 9 | Polish and housekeeping | Pending |

**Next: task 4.** It is implemented, but the project owner still has to review it. Don't start task 5 yet. Ask the owner for their feedback on the per-chat role styles, adjust whatever doesn't fit their needs, and raise the open points listed under task 4 in the plan. Mark task 4 as Done only after the owner approves it.

### Working agreements

- Deliver one task at a time. Verify it in the browser on desktop and mobile widths, then report back and wait for the owner before starting the next task.
- Keep the classic panels intact. Simple UI controls mirror classic controls: set the value and trigger the classic event. Don't duplicate saving logic.
- Scope all styles to `body.simple-ui`. Write UI strings in English with `t\`...\`` and add the Spanish translations to `public/locales/es-es.json`.
- Update the task statuses in `docs/simple-ui-plan.md` and in this index whenever a task changes state.

### Running

- Start the server with `npm start` and open `http://localhost:8000`.
- Lint with `npm run lint`. It needs the dev dependencies installed.
