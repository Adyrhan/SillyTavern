# Plan — Native OOC mode in SillyTavern

## Goal

When the user sends an *out of character* (OOC) message, the model answers **out of character**. It has the full roleplay context (character card, persona, lore and history), but **receives no prompt that puts it into character**.

## Approach

OOC mode **does not go through the roleplay pipeline**. Instead of modifying the prompt that `Generate()` builds (preset, Prompt Manager, instruct template, Author's Note, depth prompts, group nudge…), a dedicated request is built from scratch and sent with `generateRaw()` (`script.js:4122`), which already works with both Chat Completion and Text Completion.

The roleplay history is not sent as a conversation to continue, but as **a quoted transcript inside a reference document**. This is the key: the model is not "in the middle of the scene". It reads the scene as a document and answers a question about it.

Everything sent to the model is controlled by this code:

```
[system]  OOC prompt (configurable)
[user]    # Story reference
          ## Characters        ← description / personality / scenario
          ## {{user}}          ← persona
          ## Lore              ← activated World Info (optional)
          ## Transcript        ← latest turns, trimmed to the token budget
          # Question from the co-author
          <OOC message with markers stripped>
```

In Text Completion, `createRawPrompt` (`script.js:3924`) formats this with the active instruct template (story string → user turn → `last_system_sequence` or `output_sequence`), **without** the `{{char}}:` prefix, because it generates with `isQuiet = true` and `quietToLoud = false` (`instruct-mode.js:590-611`).

### What is not involved

CC preset and Prompt Manager (`main`, `jailbreak`, `nsfw`, `enhanceDefinitions`, custom prompts), the card's system prompt and post-history instructions, the TC system prompt, story string and `last_output_sequence`, Author's Note, depth prompts, group nudge, example dialogues, and the character name prefix.

### Known leftovers

- **Extensions listening to prompt events.** `generateRawData` emits `GENERATE_AFTER_COMBINE_PROMPTS` and `CHAT_COMPLETION_PROMPT_READY` (`script.js:4028-4036`), so an installed extension could modify the request. Core extensions do not inject roleplay instructions there.
- **"Stay in character" phrases inside content** (description, World Info). They arrive as quoted reference material, not as instructions. This is expected: the model needs to know who the character is.

---

## 1. Flow

```
Generate(type)
 ├─ GENERATION_STARTED / processCommands / GENERATION_AFTER_COMMANDS / ping
 ├─ ► OOC DIVERSION  (script.js ~4352, before the group redirect)
 │     if (!dryRun && !depth && getOocMode(type, textarea) === OOC_MODE.RUN) {
 │         deactivateSendButtons();
 │         try { await runOocGeneration(type, textarea); }
 │         finally { unblockGeneration(type); }
 │         return;
 │     }
 └─ …roleplay pipeline unchanged…
```

The diversion lives **inside** `Generate()`, after slash commands and the server ping, for three reasons:

- Every way of starting a generation passes through it: send, regenerate, swipe, `/trigger`, `/ask`, auto-continue, etc.
- `GENERATION_STARTED` has already been emitted, so the typing indicator and the stop button work. Stop emits `GENERATION_STOPPED` (`script.js:5618`) and `generateRawData` already aborts on that event (`script.js:4018`).
- `unblockGeneration` (`script.js:5693`) re-enables the buttons and emits `GENERATION_ENDED` via `hideStopButton`.

`generation_started` is already set at the start of `Generate`, so `saveReply` records timings correctly.

## 2. Detection — `getOocMode(type, textareaText)` in `public/scripts/ooc.js`

Returns `OOC_MODE.RUN`, `OOC_MODE.SKIP` (normal pipeline) or `OOC_MODE.BLOCK` (warn and generate nothing).

| Type | Condition for RUN |
|------|-------------------|
| `normal` with text in the textarea | Toggle armed **or** the text matches a pattern. |
| `normal` with an empty textarea (`/trigger`, empty send) | The last message is from the user and is OOC (`extra.ooc` or pattern). |
| `regenerate` / `swipe` | The last message is an OOC reply (`!is_user && extra.ooc`). For `regenerate`, a last message that is an OOC user message also counts. |
| `continue` | If the last message is an OOC reply → **BLOCK** with a toast ("Continue is not available for OOC replies"). Otherwise → SKIP. |
| `impersonate`, `quiet` | Always SKIP. |
| Group chat | v1: always SKIP (see [Out of scope for v1](#out-of-scope-for-v1)). |
| `power_user.ooc.enabled === false` | Always SKIP. |

- **Patterns:** `power_user.ooc.patterns`, one regex per line, compiled with `regexFromString` (`utils.js:1387`) inside try/catch. Invalid ones are skipped with a single warning toast. Results are cached by source string.
- **OOC message:** a user message is OOC if it has `extra.ooc === true` or matches any pattern. Messages sent through the OOC path are always stamped with `extra.ooc`, so regenerating keeps working even if the patterns change later.

## 3. `runOocGeneration(type, textareaText)` — `public/scripts/ooc.js`

### 3.1 Prepare the chat for the generation type

- **`normal` with text:** clear the textarea (as in `script.js:4400-4402`) and call `sendMessageAsUser(text, '', null, false, name1, user_avatar, { ooc: true })`. The signature gets a new `extra = {}` parameter that is merged into `message.extra`. This reuses the input regex, attachments, token count and the `MESSAGE_SENT`/`USER_MESSAGE_RENDERED` events. Then call `consumeOocArmed()`.
- **`regenerate` with an OOC reply at the end:** delete that last message exactly like `script.js:4407-4411` (`deleteItemizedPromptForMessage`, `chat.length--`, `removeLastMessage`, `MESSAGE_DELETED`). Extract those four lines into an exported `deleteLastReplyForRegenerate()` and use it in both places.
- **`swipe`:** the chat is not touched. The message being answered is the second to last.

The result is `question`, the OOC user message being answered, and `historyEnd`, the index where the transcript ends (the question is excluded).

### 3.2 Build the context

Everything is resolved on the fly with existing helpers:

| Section | Source | Notes |
|---------|--------|-------|
| Characters | `getCharacterCardFields()` → `description`, `personality`, `scenario` | Labeled ("Description:", "Personality:", "Scenario:"), empty ones omitted. `system`, `jailbreak`, `mesExamples`, `charDepthPrompt` and `creatorNotes` are **not** included. |
| `{{user}}` | `power_user.persona_description` | If `include_persona` is on and it is not empty. |
| Lore | `getWorldInfoPrompt(chatForWI, maxContext, true)` (`world-info.js:892`) → `worldInfoString` | If `include_world_info` is on. `isDryRun = true` avoids side effects (timed effects, sticky). `chatForWI` is built as in `script.js:4624`. Depth and outlet entries are ignored. |
| Transcript | `chat[0 … historyEnd)` | See 3.3. |
| Question | `question.mes` with OOC markers stripped | See 3.4. |

Fixed headings in English (small models follow them better):

```
# Story reference
The following is reference material from an ongoing roleplay between {{user}} and {{char}}. It is provided for context only.

## Characters
### {{char}}
Description: …
Personality: …
Scenario: …

## {{user}}
…

## Lore
…

## Transcript (most recent last)
> {{user}}: …
> {{char}}: …
> [OOC] {{user}}: …
> [OOC] {{char}}: …

# Question from the co-author
…

<answer guidelines>
```

- The answer guidelines (`answer_guidelines`) go **last**, right after the question, where they carry the most weight for small models. The default asks for brevity.
- **Reply language.** Small models ignored an abstract "answer in the same language as the question" instruction, especially with English headings around it. Instead, `getLanguageInstruction` detects the question's language (by script for ja/ko/zh/ru, by common words plus accent hints for en/es/pt/fr/de/it). If the question is too short to tell, it also looks at the last 6 messages, ignoring previous OOC replies. It then appends an explicit instruction **written in that language** (e.g. "Responde siempre en español.") at the end of both the system prompt and the document. If detection fails, the generic instruction is used. To force a fixed language instead, a global variable can be used in both the roleplay prompt and the guidelines (`{{getglobalvar::language}}`).
- The `>` quotes and the `[OOC]` label clearly separate story from non-story.
- Empty sections are omitted entirely.

### 3.3 Transcript and token budget

- **Included messages:** everything that is not `is_system` (hidden and system messages are left out) and has no `extra[IGNORE_SYMBOL]`. Tool invocations are excluded.
- **Previous OOC exchanges:** included with the `[OOC]` label, so the user can ask follow-up questions ("what we discussed earlier…"). Their `(OOC: …)` wrappers are stripped: when the transcript showed them, the model imitated the format, started its reply with `(OOC: ` and opened `<think>` inside it, where the streaming auto-parse (which only matches at the very start) cannot see it.
- **Format:** `> ${name}: ${mes}`. In multi-line messages, every line gets `> `. Images and attachments are not included in v1.
- **Budget:**
  1. `budget = getMaxPromptTokens(responseLength)` (`script.js:5981`).
  2. Subtract the tokens of the system prompt, the fixed sections and the question (`getTokenCountAsync`), plus a 5 % margin for instruct formatting.
  3. Walk the chat **from newest to oldest**, adding turns while they fit. If `max_history_messages > 0`, also stop when that count is reached.
  4. Assemble the transcript in chronological order. If it was trimmed, start with `> […earlier messages omitted…]`.
- If even the card and the question do not fit, drop Lore first, then the card, and finally fail with a toast.

### 3.4 Clean up the question

`stripOocMarkers(text)` removes, best effort, the usual wrappers: `((…))`, `(OOC: …)`, `OOC: …` and `[OOC] …`. If the result is empty, the original is used. The transcript keeps the message as is.

### 3.5 Generate

```js
const reply = await generateRaw({
    prompt: [{ role: 'user', content: contextDocument }],
    systemPrompt: power_user.ooc.system_prompt || default_ooc_system_prompt,
    quietToLoud: false,                   // TC: no {{char}}: prefix, neutral sequence
    responseLength: power_user.ooc.response_length || null,
    trimNames: true,
});
```

- **Answer cue:** in Text Completion without an instruct template there are no turn markers, so the model just continues the text (e.g. writing its planning as the reply). In that case the request uses `prefill: 'Answer:'`, which `createRawPrompt` appends as the last line.
- **Macros:** `createRawPrompt` runs `substituteParams` over all content. To keep chat text from being reinterpreted, the transcript and the question are escaped first. There is no macro-escaping helper: `removeMacros` (`script.js:5860`) deletes them, which is not what we want. Add `escapeMacros(str)` in `ooc.js`, replacing `{{` with `{​{`. The headings deliberately use `{{char}}` and `{{user}}`.
- **Errors and abort:** if `generateRaw` throws or is aborted, show a toast (except on abort) and save nothing. The user message already sent stays.
- **Streaming:** when streaming is enabled for the current API (`isStreamingEnabled()`), `streamRawReply` (in `script.js`) is used instead of `generateRaw`. It builds the request exactly like a quiet raw generation (shared `createRawGenerationData`, same prompt events), so Chat Completion adds no assistant prefill, tool calls or multiple swipes. It forces streaming with a new `forceStream` request option (`createGenerationParameters`/`sendOpenAIRequest`), and streams into the chat with the regular `StreamingProcessor`, which now accepts the new message's `extra` (so `extra.ooc` is set from the first token). After the stream finishes (or is stopped), `finalizeStreamedReply` applies the same post-processing as the non-streaming path: reasoning split, incomplete-sentence trim and `(OOC: …)` wrapping.

### 3.6 Save the reply

- `saveReply({ type: type === 'swipe' ? 'swipe' : 'normal', getMessage: text, extra: { ooc: true } })`.
- `saveReply` (`script.js:6642`) gets an optional `extra` parameter merged into `newMessage.extra` (normal branch) or `lastMessage.extra` (swipe branch) **before** emitting `MESSAGE_RECEIVED`/`CHARACTER_MESSAGE_RENDERED`. Extensions (TTS, expressions…) then already see `extra.ooc` and can ignore the message.
- The reply is attributed to `name2` (the character, with its avatar) and is visually marked as OOC (see 6).
- **Samplers and length:** `generateRaw` uses the active preset's samplers and stopping strings. The response length is the preset's unless `response_length > 0`. Since roleplay presets usually have long response lengths, `answer_guidelines` asks for brevity, and `trim_incomplete_sentences` (default on) runs `trimToEndSentence` so a reply cut by the token limit does not end mid-sentence.
- **Reasoning:** the reasoning block is split from the reply **before** trimming or wrapping (`splitReasoning`, using the selected reasoning template's prefix/suffix, defaulting to `<think>`/`</think>`). It handles a missing opening tag and an unterminated block (reply cut off while reasoning → warning toast, nothing saved). The reasoning is passed to `saveReply({ reasoning })` with `reasoning_type: parsed`, so it shows in the reasoning block like a normal reply. Without this, wrapping as `(OOC: <think>…)` stops the regular auto-parse from finding the block, because it only matches at the start of the message.
- **Wrapping:** if `wrap_reply` is on and the reply does not already start with `(OOC`, it is saved as `(OOC: ${text})`. The code does this, not the model, so the prompt does not need to ask for it and stays cleaner for small models.

## 4. Keep OOC out of the roleplay

If `power_user.ooc.exclude_from_context` is on (default), messages with `extra.ooc` are excluded from the roleplay pipeline. A single filter where `coreChat` is built (`script.js:4496`) is enough:

```js
let coreChat = chat.filter(x => (!x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)))
    && !(power_user.ooc.exclude_from_context && x.extra?.ooc));
```

The character does not "remember" OOC conversations or pick up their tone. The OOC transcript (3.3) does include them.

> Check that `setInContextMessages` and the "last in context" marker stay consistent. The filter also affects `chatForWI` and the in-context message count, which is the desired behavior.

## 5. Settings — `power_user.ooc`

Independent of the API and the preset. Defaults and logic live in a new module, `public/scripts/ooc.js`.

```js
ooc: {
    enabled: true,
    system_prompt: default_ooc_system_prompt,
    patterns: default_ooc_patterns,
    answer_guidelines: default_ooc_answer_guidelines,
    include_persona: true,
    include_world_info: true,
    max_history_messages: 0,      // 0 = as many as fit
    response_length: 0,           // 0 = use the preset's
    wrap_reply: true,
    trim_incomplete_sentences: true,
    exclude_from_context: true,
},
```

```js
export const default_ooc_system_prompt = 'You are a helpful writing assistant. The user is the co-author of an ongoing roleplay story between {{user}} and {{char}}, and is asking you a question about it, outside of the story. Use the reference material to understand the characters and what has happened so far. Answer the question directly, as yourself. Do not continue the story, and do not write dialogue, thoughts or actions for any character.';
export const default_ooc_patterns = '/^\\s*\\(\\(/\n/^\\s*\\(?\\s*\\[?OOC\\]?\\s*:/i';
```

- Defaults live in `ooc.js`. `initOocMode()` runs after settings are loaded (next to `initReasoning()`) and fills in missing keys with `Object.assign({}, defaults, power_user.ooc)`. `power-user.js` is not touched: `loadPowerUserSettings` already copies `settings.power_user` wholesale, so `power_user.ooc` persists.
- UI in *Advanced Formatting*, in a new **"Out-of-Character Mode"** block below System Prompt. One control per setting, with `data-i18n` and a tooltip. The system prompt textarea has `data-macros`; both the system prompt and the patterns have a restore-default button. Handlers call `saveSettingsDebounced()`, following the pattern in `reasoning.js` (`loadReasoningSettings`).

## 6. Chat UI

- **Toggle** `#mes_ooc` next to `#mes_impersonate` (`index.html:8120`), e.g. `fa-solid fa-comment-slash`. Clicking toggles the one-shot armed state. While armed, the `.ooc_armed` class is applied to the icon and to `#send_textarea`. It is disarmed when consumed or on `CHAT_CHANGED`. Hidden in group chats and when OOC mode is disabled.
- **Message marker:** when rendering (`addOneMessage`), messages with `extra.ooc` get an `ooc="true"` attribute on `.mes`. CSS adds an "OOC" label next to the name and a dimmed style, to set them apart from the roleplay.
- **Slash command (optional):** `/ooc <text>` sends the text as OOC (arms the toggle and calls `Generate('normal')`).

## Out of scope for v1

- **Group chats.** Still to decide: who the reply is attributed to, which cards are included, and how to keep the group wrapper from generating one reply per member. Can be added later by diverting before `generateGroupWrapper` and including the cards of all active members.
- **Continue on OOC replies.**
- **Prompt itemization** for OOC requests (the sent prompt could be stored in `itemizedPrompts` with an `ooc` type).
- Images and attachments in the transcript.
- A configurable template for the context document.

## Files touched

- `public/scripts/ooc.js` (new): defaults and settings UI, `getOocMode`, patterns, armed state, `stripOocMarkers`, context building and `runOocGeneration`.
- `public/script.js`:
  - diversion in `Generate`;
  - `coreChat` filter;
  - `extra` parameter in `sendMessageAsUser` and `saveReply`;
  - extracted `deleteLastReplyForRegenerate()`;
  - `ooc` attribute in `updateMessageElement` (used by `addOneMessage`);
  - `initOocMode()` call during app init.
  The `try/finally` with `unblockGeneration` stays in `Generate`, as in the pseudocode in section 1, so `unblockGeneration` does not need to be exported.
- `public/scripts/openai.js`: `forceStream` option in `createGenerationParameters` and `sendOpenAIRequest`.
- `public/index.html`: settings block and `#mes_ooc` icon.
- `public/style.css`: `#mes_ooc`, `.ooc_armed` and `.mes[ooc="true"]`.
- `public/locales/*.json`: not updated yet. The English text in the markup is the fallback; translations can be added later.

## Verification

To inspect each request, use the `generateRawData` console logs or the network tab.

1. **No roleplay in the request (CC):** with a preset that has `main`, `jailbreak` and custom roleplay prompts, send `((what do you think of how the scene is going?))`. The request contains only the OOC system prompt and the context document, and the reply is saved with `extra.ooc` and the OOC marker.
2. **No roleplay in the request (TC, KoboldCpp or llama.cpp with an instruct template):** the prompt contains neither the system prompt, the story string nor `last_output_sequence`, and does not end in `{{char}}:`.
3. **Enough context:** ask OOC about something that only appears in the history and something that only appears in the card. The answer uses both.
4. **Budget:** in a long chat with a small context, the transcript is trimmed from the start, the omission marker appears and the request does not exceed the maximum.
5. **Armed toggle + message without prefix:** generates in OOC. `/send` with the toggle armed does not consume it.
6. **Swipe and regenerate** on an OOC reply: generate in OOC again. **Continue** on it: shows the warning.
7. **Next normal message:** uses the roleplay pipeline and, with `exclude_from_context`, the prompt itemization does not contain the OOC exchanges.
8. **Stop** during an OOC generation: aborts without saving and the buttons return to their normal state.
9. **Invalid pattern** `/(/`: the warning toast appears and everything else works.
10. **Group chat:** a message with `((…))` goes through the normal pipeline (v1).
11. `npm run lint` with no new errors.
