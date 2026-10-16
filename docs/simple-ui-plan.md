# Simple UI: design, plan and progress

This document is the source of truth for the "simple UI" redesign of SillyTavern. It records the goals, the decisions the project owner made, the architecture, and the state of every task, so that any contributor (human or model) can pick the work up. The task index and the next task are in [`CLAUDE.md`](../CLAUDE.md).

Branch: `feature/simple-ui` (started from `feature/ooc-mode`, which adds the native out-of-character mode described in [`ooc-mode-plan.md`](ooc-mode-plan.md)).

## Context and goal

SillyTavern is aimed at power users. Its UI is a bar of nine drop-down drawers at the top of the screen (`#top-settings-holder` in `public/index.html`), each holding hundreds of controls: samplers, instruct templates, logit bias, STscript and more. A new user has to understand "API Connections", "AI Response Configuration" and "Advanced Formatting" before they can roleplay.

The goal is an alternative UI that is clean, fast to start with and focused on roleplay (including OOC mode). It ships sensible presets per use case, and every other setting stays reachable under "Advanced".

## Decisions made by the project owner

| Topic | Decision |
|---|---|
| Relation with the classic UI | The new navigation **replaces** the top drawer bar. The classic drawers are kept intact (DOM and JS untouched) and open only from Settings → Advanced, as a full-height overlay. An escape hatch to the classic UI exists (see below). |
| Backends | All backends stay available. The default is **Chat Completion with the `custom` source (OpenAI-compatible)**, with settings that work without tuning in most cases. Locally running engines (LM Studio, llama.cpp, KoboldCpp, Ollama…) are auto-detected and configured. |
| Platforms | Desktop and mobile are equally important. The sidebar becomes a slide-in drawer on narrow screens (≤1000px). |
| Role styles v1 | Action, Adventure/fantasy, Companion/conversation, Game master/narrator, Romance/slice of life. |
| Role style scope | **Per chat.** Each chat stores and restores its own role style, so switching chats never mixes styles. The Settings tab only holds the default style for new chats. |
| Language | UI strings are written in English through `t\`...\``. Spanish translations are added to `public/locales/es-es.json`. |

## Architecture

All new code is scoped to `body.simple-ui`. That class is set in `public/index.html`, so there is no flash of the classic top bar, and it is removed at startup if the user switched to the classic UI.

| File | Role |
|---|---|
| `public/scripts/simple-ui.js` | Shell: sidebar (new story, search, recent chats, characters, persona, settings), chat header (avatar, name, model, role style chip, connection pill, character card, World Info, "…" menu), OOC mode switch in the composer, overlay bar ("Back") for classic drawers, classic/simple toggle. Exports `openAdvancedPanel(drawerId)`, `closeAdvancedPanels()`, `isSimpleUi()`, `setSimpleUiEnabled()`, `getConnectedModelLabel()`, `refreshChatHeader()`. |
| `public/scripts/simple-ui-settings.js` | Tabbed settings dialog: Connection, Default role style, Me, Appearance, Out of character, Advanced. Also exports `openChatRoleStyle()`, the per-chat role style dialog. Every control mirrors a classic control: it reads the classic value and writes back by setting it and triggering its event, so the existing saving logic is reused. |
| `public/scripts/simple-ui-styles.js` | Role style definitions, plus per-chat storage and injection. |
| `public/css/simple-ui.css` | All styles of the shell, dialogs and overlay, including the mobile rules. |
| `src/endpoints/backends/autodetect.js` | `POST /api/backends/autodetect`: probes the default ports of local engines on 127.0.0.1. |

Changes to existing files:
- `public/script.js`: imports and calls `initSimpleUi()` after `initWelcomeScreen()`.
- `public/scripts/RossAscends-mods.js`: `OpenNavPanels()` doesn't auto-open pinned drawers in simple UI.
- `public/scripts/welcome-screen.js`: exports `getRecentChats`, `openRecentCharacterChat` and `openRecentGroupChat`.
- `public/scripts/personas.js`: `setPersonaName(avatarId, name)` is extracted from `renamePersona` and exported.
- `src/server-startup.js`: registers the autodetect router.
- `default/content/settings.json`: new installs default to `main_api: openai` and `chat_completion_source: custom`, instead of Horde.
- `public/index.html`: adds the `simple-ui` body class and the stylesheet link.

Key mechanisms:
- **Classic drawers as overlay.** `openAdvancedPanel()` waits one tick, so the document click handler in `script.js` that closes drawers on outside clicks doesn't close the one being opened. It then calls `doNavbarIconClick` on the drawer toggle. CSS turns `.drawer-content.openDrawer` into a fixed full-height sheet with a "Back" bar (`#su-advanced-bar`, placed inside `#top-settings-holder` so it shares the drawers' stacking context). Escape closes it. A drawer opened from inside the settings dialog must close the dialog first (`openPanelFromSettings`), or it would be hidden behind the modal `<dialog>`.
- **Mobile.** `<html>` gets a transform on mobile, which makes it the containing block of fixed elements. Fixed elements of the shell therefore use explicit `100vw`/`100dvh` sizes instead of `inset: 0`.
- **OOC switch.** `ooc.js` owns the one-shot "armed" state of `#mes_ooc`. The composer switch calls `armOoc()` and mirrors the button through a `MutationObserver`. It is hidden whenever `#mes_ooc` is, that is when OOC is disabled or in group chats.
- **Message actions.** Only swipe, edit and copy are shown. Delete is kept in the edit mode. Other actions stay in the classic UI.
- **Classic escape hatch.** Settings → Advanced → "Use the classic interface" sets `accountStorage['SimpleUiDisabled'] = 'true'` and reloads. In the classic UI, the "≡" options menu gets a "Simple interface" entry that reverses it.

## Inventory: what the simple UI shows

| Classic panel | In the simple UI |
|---|---|
| AI Response Configuration (presets, samplers) | Hidden. Role style (length and creativity) covers the essentials. |
| API Connections | Settings → Connection (providers + local detection). Everything else is under "Other backends…" or Advanced. |
| AI Response Formatting (instruct, context, system prompt, OOC) | Hidden. OOC basics are in Settings → Out of character. |
| World Info | Book button in the chat header (opens the classic panel for now). |
| User Settings | Settings → Appearance (theme, chat style, text size, language). The rest is under Advanced. |
| Backgrounds | Settings → Appearance → "Choose background". |
| Extensions | Under Advanced only, for now (see task 7). |
| Persona Management | Settings → Me (name, picture, description). Several personas: Advanced. |
| Character Management | Sidebar + "New story" picker. Editing: card button in the header (classic panel). |
| Group chats | Out of scope for v1. They still work, and recent group chats open from the sidebar. |

## Tasks

Statuses: **Done**, **In review** (implemented, waiting for the project owner's review), **Pending**.

### Task 1: Shell and navigation (Done)

The sidebar replaces the top bar and the character drawer. On mobile it becomes a drawer opened with ☰.
- The chat header shows the character, the model, the connection pill, the character card and World Info buttons, and a "…" menu. The menu offers new chat, previous chats, regenerate, "write my reply" (impersonate), Author's Note, delete messages and close chat; each item triggers the matching `#option_*` item.
- The composer has an "In character / Out of character (OOC)" switch.
- Message actions are reduced to the essential ones.
- The overlay host for classic drawers has a Back bar.
- "New story" opens a character picker; picking a character starts a fresh chat if the current one has user messages.

Verified on desktop (1024px) and mobile (375px).

### Task 2: Settings dialog (Done)

The settings dialog has these tabs:
- **Connection:**
  - Provider cards: OpenAI-compatible (default), OpenRouter, OpenAI, Anthropic, Google AI Studio, DeepSeek, and "Other backends…", which opens the classic API Connections panel.
  - A form with server URL (custom only), API key and model.
  - Connect switches `#main_api` and `#chat_completion_source` and clicks `#api_button_openai`.
  - The status shows the model name, through `getConnectedModelLabel()`, because custom sources report "Valid".
- **Me:** name (`setPersonaName`), picture (`#persona_set_image_button`), description (`#persona_description`).
- **Appearance:** theme (`#themes`), chat style (`#chat_display`), text size (`#font_scale`), language (`#ui_language_select`), background.
- **Out of character:** enable, exclude from context, include World Info, and a link to the prompts.
- **Advanced:** links to the nine classic panels, plus the classic UI toggle.

### Task 3: Local engine auto-detection (Done)

`POST /api/backends/autodetect` probes these ports, each with a 1.2s timeout and all in parallel:

| Engine | Address | Notes |
|---|---|---|
| LM Studio | `:1234` | The loaded model is listed first; embedding models are dropped. |
| llama.cpp | `:8080` | Identified by `/props`. |
| KoboldCpp | `:5001` | Identified by `/api/v1/model`. |
| Ollama | `:11434` | Read from `/api/tags`. |
| text-generation-webui | `:5000` | macOS AirPlay on this port is ignored, because it doesn't answer as a model list. |

Only fixed loopback addresses are probed, so there is no SSRF surface. The endpoint returns `{ backends: [{ engine, label, baseUrl, models }] }`. The Connection tab runs detection automatically when not connected (or on "Find it"), lists the results with a model selector, and "Use" connects through the OpenAI-compatible source. Tested against a real LM Studio and fake servers for the other engines (about 30 ms total).

### Task 4: Role styles, per chat (In review: NEXT)

The five styles are defined in `simple-ui-styles.js`. Each has an English prompt that includes "never write {{user}}'s actions" and "write in the language of the conversation", plus a default length (short 250, medium 450 or long 750 tokens) and a default creativity (temperature 0.7, 0.9 or 1.1). A "No style" option uses only the user's own prompt.

Behaviour after the owner's feedback ("the role style must belong to each chat"):
- Stored in `chat_metadata.simple_ui_role_style = { style, length, creativity }` and saved with `saveMetadataDebounced()`.
- On `CHAT_CHANGED`:
  - A chat with no user messages and no stored style gets the default style (`accountStorage['SimpleUiDefaultRoleStyle']`, Adventure if unset).
  - The chat's style prompt is injected with `setExtensionPrompt('SIMPLE_UI_ROLE_STYLE', …, BEFORE_PROMPT)`. The user's main or system prompt is never overwritten.
  - Length and creativity are written to `#openai_max_tokens` and `#temp_openai`, or `#amount_gen` and `#temp_textgenerationwebui`. The prompt injection works with every backend; the samplers only apply to Chat Completion and Text Completion.
- Old chats that never got a style are left alone; their chip says "Choose style".
- The chat header chip (`#su-style-chip`) opens the per-chat picker. Settings → "Default role style" edits the default for new chats.

Verified: applying a style, switching chats (each chat restores its own style), reloading.

**What's left:** the owner reviews this and asks for adjustments. Open points to raise with them:
- Chats without a style keep the length and temperature left by the previous chat. Should a baseline be restored, or should old chats get the default style too?
- Wording, number and prompts of the styles.
- Whether the style chip should also show length and creativity.

### Task 5: Onboarding wizard (Pending)

This replaces `doOnboarding` (`public/script.js`, around `firstRun`) in simple UI. The steps are:
1. Language.
2. Your name.
3. Connect an AI: reuse the Connection tab content, including auto-detection.
4. Pick a character (sample Seraphina or import) and a role style, then open the chat.

Add a "Set up manually" link that opens Settings → Advanced. Test with the `forceOnboarding` debug function (`script.js`).

### Task 6: Sweep of drawer openers (Pending)

These places still open classic drawers directly:
- `.drawer-opener` buttons in `public/scripts/templates/welcome.html`, used by the welcome screen.
- Slash commands.
- Built-in extensions that call `doNavbarIconClick` or click drawer icons.

They work, because the overlay catches them, but they should open the simple equivalent where one exists: for example API Connections → Settings → Connection, and Character Management → the character picker. The welcome screen ("SillyTavern System" with Docs and GitHub links) could also be replaced by a simpler start view.

### Task 7: Extensions tab (Pending)

A minimal tab to enable or disable installed extensions. Management and installation stay under Advanced.

### Task 8: Character card and world in the simple UI (Pending)

The header buttons currently open the classic Character Management and World Info drawers. The planned replacement is a simple panel showing the character description, the attached lorebook (on/off) and the Author's Note.

### Task 9: Polish and housekeeping (Pending)

- Run `npm run lint`. ESLint dev dependencies are not installed in this checkout, so lint has not been run on the new code.
- Translations for locales other than `es-es`.
- Escape doesn't close the overlay when focus is inside a drawer textarea.
- Decide whether the OOC switch should stay one-shot (it returns to "In character" after sending) or become sticky.

## How to verify

1. Run `npm start` (port 8000) and open `http://localhost:8000`.
2. Desktop and mobile (375px) widths:
   - Sidebar, header and "…" menu.
   - OOC switch.
   - Settings tabs.
   - Opening each classic panel from Advanced and closing it with Back or Escape.
3. Connection:
   - With LM Studio, Ollama, KoboldCpp or llama.cpp running, the Connection tab lists them and "Use" connects.
   - With none running, it says so quickly.
4. Role styles:
   - Pick a style in one chat and another style in a second chat.
   - Switch between them: the header chip, the injected prompt (`SillyTavern.getContext().extensionPrompts.SIMPLE_UI_ROLE_STYLE`), the temperature and the max tokens follow each chat.
   - Reload and check again.
5. Classic toggle: Settings → Advanced → "Use the classic interface", then "Simple interface" from the options menu.
