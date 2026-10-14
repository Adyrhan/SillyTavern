import {
    chat,
    deleteLastMessage,
    deleteLastReplyForRegenerate,
    event_types,
    eventSource,
    generateRaw,
    getCharacterCardFields,
    getMaxPromptTokens,
    isStreamingEnabled,
    saveChatConditional,
    saveReply,
    saveSettingsDebounced,
    sendMessageAsUser,
    streamRawReply,
    syncMesToSwipe,
    updateMessageBlock,
} from '../script.js';
import { IGNORE_SYMBOL } from './constants.js';
import { selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { regex_placement, getRegexedString } from './extensions/regex/engine.js';
import { power_user } from './power-user.js';
import { ReasoningType } from './reasoning.js';
import { getTokenCountAsync } from './tokenizers.js';
import { regexFromString, trimToEndSentence } from './utils.js';
import { getWorldInfoPrompt, world_info_include_names } from './world-info.js';

export const default_ooc_system_prompt = 'You are a helpful writing assistant. The user is the co-author of an ongoing roleplay story between {{user}} and {{char}}, and is asking you a question about it, outside of the story. Use the reference material to understand the characters and what has happened so far. Answer the question directly, as yourself. Do not continue the story, and do not write dialogue, thoughts or actions for any character.';
export const default_ooc_patterns = '/^\\s*\\(\\(/\n/^\\s*\\(?\\s*\\[?OOC\\]?\\s*:/i';
export const default_ooc_answer_guidelines = 'Keep your answer brief and to the point: a few sentences at most, unless the question explicitly asks for more detail.';

/** Previous defaults, upgraded on load if the user never edited them */
const legacy_ooc_answer_guidelines = [
    'Keep your answer brief and to the point: a few sentences at most, unless the question explicitly asks for more detail. Always answer in the same language the question is written in.',
];

/** Used when the language of the question cannot be detected */
const FALLBACK_LANGUAGE_INSTRUCTION = 'Always answer in the same language the question is written in.';

/**
 * Languages that can be detected, with an answer instruction written in the language itself:
 * small models follow a language instruction much better when it is written in that language.
 * @type {Record<string, {instruction: string, script?: RegExp, hint?: RegExp, words?: Set<string>}>}
 */
const OOC_LANGUAGES = {
    ja: { instruction: '必ず日本語で答えてください。', script: /[\u3040-\u30ff]/ },
    ko: { instruction: '항상 한국어로 답하세요.', script: /[\uac00-\ud7af]/ },
    zh: { instruction: '请始终用中文回答。', script: /[\u4e00-\u9fff]/ },
    ru: { instruction: 'Всегда отвечай на русском языке.', script: /[\u0400-\u04ff]/ },
    en: {
        instruction: 'Always answer in English.',
        words: new Set('the and is are you what how why do does it this that of to in for with be was would can should my think about not have i if did she he her his they them there will'.split(' ')),
    },
    es: {
        instruction: 'Responde siempre en español.',
        hint: /[ñ¿¡]/,
        words: new Set('el la los las de que y en un una es por para con no qué cómo por cuál se lo le del al pero más esto eso esta este crees tu mi está hay sí muy también puedes sería piensas opinas ella él porque dónde cuándo'.split(' ')),
    },
    pt: {
        instruction: 'Responda sempre em português.',
        hint: /[ãõ]/,
        words: new Set('o a os as de que e em um uma é para com não você como do da mas isso isto muito eu está são uma acha pode seria'.split(' ')),
    },
    fr: {
        instruction: 'Réponds toujours en français.',
        hint: /[œ]|\b(?:c|j|l|d|qu|n)'/,
        words: new Set('le la les de des et est un une que qui pas pour dans avec ce cette je tu il vous nous quoi comment pourquoi mais très être sur penses'.split(' ')),
    },
    de: {
        instruction: 'Antworte immer auf Deutsch.',
        hint: /[ßäöü]/,
        words: new Set('der die das und ist nicht ich du ein eine zu mit was wie warum auf für es sie wir den dem auch aber sehr denkst'.split(' ')),
    },
    it: {
        instruction: 'Rispondi sempre in italiano.',
        words: new Set('il lo la gli le di che e è un una per con non cosa come perché del della sono ma anche questo questa molto mi ti pensi'.split(' ')),
    },
};

/** Minimum number of common words needed to trust a detection */
const MIN_LANGUAGE_SCORE = 2;

const default_ooc_settings = Object.freeze({
    enabled: true,
    system_prompt: default_ooc_system_prompt,
    patterns: default_ooc_patterns,
    answer_guidelines: default_ooc_answer_guidelines,
    include_persona: true,
    include_world_info: true,
    max_history_messages: 0,
    response_length: 0,
    wrap_reply: true,
    trim_incomplete_sentences: true,
    exclude_from_context: true,
});

/**
 * How a generation request should be handled with regard to out-of-character mode.
 * @readonly
 * @enum {string}
 */
export const OOC_MODE = {
    /** Use the regular roleplay generation pipeline */
    SKIP: 'skip',
    /** Generate an out-of-character reply */
    RUN: 'run',
    /** Do not generate anything */
    BLOCK: 'block',
};

/** Share of the prompt budget kept free for instruct/chat formatting overhead */
const BUDGET_SAFETY_MARGIN = 0.05;
/** Number of recent messages used to detect the language when the question alone is too short */
const LANGUAGE_CONTEXT_MESSAGES = 6;
const OMITTED_MARKER = '> […earlier messages omitted…]';

let oocArmed = false;

/** @type {{source: string|null, patterns: RegExp[]}} */
let patternCache = { source: null, patterns: [] };

/**
 * Checks if out-of-character messages should be left out of the roleplay prompt.
 * @returns {boolean}
 */
export function isOocExcludedFromContext() {
    return !!power_user.ooc?.enabled && !!power_user.ooc?.exclude_from_context;
}

/**
 * Compiles the configured detection patterns, caching them by their source string.
 * @returns {RegExp[]}
 */
function getOocPatterns() {
    const source = String(power_user.ooc?.patterns ?? '');
    if (patternCache.source === source) {
        return patternCache.patterns;
    }

    const patterns = [];
    const invalid = [];
    for (const line of source.split('\n').map(x => x.trim()).filter(Boolean)) {
        const regex = regexFromString(line);
        if (!regex) {
            invalid.push(line);
            continue;
        }
        // Stateful flags would make test() skip matches on repeated calls
        patterns.push(new RegExp(regex.source, regex.flags.replace(/[gy]/g, '')));
    }

    if (invalid.length) {
        toastr.warning(invalid.join('\n'), t`Invalid OOC detection patterns were ignored`);
    }

    patternCache = { source, patterns };
    return patterns;
}

/**
 * Checks if the text matches any of the out-of-character detection patterns.
 * @param {string} text Text to check
 * @returns {boolean}
 */
function matchesOocPattern(text) {
    return typeof text === 'string' && getOocPatterns().some(re => re.test(text));
}

/**
 * Checks if the message is an out-of-character user message.
 * @param {ChatMessage} message
 * @returns {boolean}
 */
function isOocUserMessage(message) {
    return !!message?.is_user && (message.extra?.ooc === true || matchesOocPattern(message.mes));
}

/**
 * Checks if the message is an out-of-character reply.
 * @param {ChatMessage} message
 * @returns {boolean}
 */
function isOocReply(message) {
    return !!message && !message.is_user && !message.is_system && message.extra?.ooc === true;
}

/**
 * Finds the closest non-system message before the given index.
 * @param {number} index Index to search before
 * @returns {number} Message index or -1
 */
function findPreviousMessageIndex(index) {
    for (let i = index - 1; i >= 0; i--) {
        if (!chat[i]?.is_system) {
            return i;
        }
    }
    return -1;
}

/**
 * Determines how a generation request should be handled.
 * @param {string} type Generation type
 * @param {string} textareaText Text in the send textarea
 * @returns {OOC_MODE}
 */
export function getOocMode(type, textareaText) {
    if (!power_user.ooc?.enabled || selected_group || !chat.length && !textareaText) {
        return OOC_MODE.SKIP;
    }

    const lastMessage = chat[chat.length - 1];

    switch (type) {
        case undefined:
        case 'normal': {
            if (textareaText.trim()) {
                return oocArmed || matchesOocPattern(textareaText) ? OOC_MODE.RUN : OOC_MODE.SKIP;
            }
            return isOocUserMessage(lastMessage) ? OOC_MODE.RUN : OOC_MODE.SKIP;
        }
        case 'regenerate': {
            if (lastMessage?.is_user) {
                return isOocUserMessage(lastMessage) ? OOC_MODE.RUN : OOC_MODE.SKIP;
            }
            const answered = chat[findPreviousMessageIndex(chat.length - 1)];
            return isOocReply(lastMessage) || isOocUserMessage(answered) ? OOC_MODE.RUN : OOC_MODE.SKIP;
        }
        case 'swipe': {
            if (!lastMessage || lastMessage.is_user) {
                return OOC_MODE.SKIP;
            }
            const answered = chat[findPreviousMessageIndex(chat.length - 1)];
            return isOocReply(lastMessage) || isOocUserMessage(answered) ? OOC_MODE.RUN : OOC_MODE.SKIP;
        }
        case 'continue': {
            if (isOocReply(lastMessage)) {
                toastr.info(t`Continue is not available for out-of-character replies.`);
                return OOC_MODE.BLOCK;
            }
            return OOC_MODE.SKIP;
        }
        default:
            return OOC_MODE.SKIP;
    }
}

/**
 * Detects the language of a text by its script or by counting common words (best effort).
 * @param {string} text Text to analyze
 * @returns {string|null} Language code from OOC_LANGUAGES, or null if unsure
 */
function detectLanguage(text) {
    const value = String(text ?? '');

    for (const [code, language] of Object.entries(OOC_LANGUAGES)) {
        if (language.script?.test(value)) {
            return code;
        }
    }

    const tokens = value.toLowerCase().match(/[\p{L}']+/gu) ?? [];
    const scores = Object.entries(OOC_LANGUAGES)
        .filter(([, language]) => language.words)
        .map(([code, language]) => {
            const wordScore = tokens.filter(token => language.words.has(token)).length;
            const hintScore = language.hint?.test(value) ? 2 : 0;
            return { code, score: wordScore + hintScore };
        })
        .sort((a, b) => b.score - a.score);

    const [best, second] = scores;
    if (!best || best.score < MIN_LANGUAGE_SCORE || best.score === second?.score) {
        return null;
    }

    return best.code;
}

/**
 * Gets the instruction that makes the model answer in the language of the question.
 * Recent messages are used as a fallback when the question is too short to tell.
 * @param {string} question Question text
 * @param {ChatMessage[]} history Messages before the question, oldest first
 * @returns {string}
 */
function getLanguageInstruction(question, history) {
    // Previous OOC replies may be in the wrong language, so they are not used as evidence
    const recent = history.filter(x => !(x.extra?.ooc && !x.is_user)).slice(-LANGUAGE_CONTEXT_MESSAGES).map(x => x.mes);
    const code = detectLanguage(question) ?? detectLanguage([question, ...recent].join('\n'));
    return code ? OOC_LANGUAGES[code].instruction : FALLBACK_LANGUAGE_INSTRUCTION;
}

/**
 * Separates the reasoning block from the reply, using the selected reasoning template.
 * Also handles a missing opening tag (some templates open it in the prompt) and
 * an unterminated block (the reply was cut off while reasoning).
 * @param {string} text Raw reply
 * @returns {{content: string, reasoning: string, truncated: boolean}}
 */
function splitReasoning(text) {
    const template = power_user.reasoning?.prefix && power_user.reasoning?.suffix ? power_user.reasoning : { prefix: '<think>', suffix: '</think>' };
    const prefix = template.prefix.trim();
    const suffix = template.suffix.trim();
    const prefixIndex = text.indexOf(prefix);
    const suffixIndex = text.indexOf(suffix);

    if (suffixIndex !== -1 && (prefixIndex === -1 || prefixIndex < suffixIndex)) {
        const start = prefixIndex === -1 ? 0 : prefixIndex + prefix.length;
        const before = prefixIndex === -1 ? '' : text.slice(0, prefixIndex);
        return {
            reasoning: text.slice(start, suffixIndex).trim(),
            content: `${before}${text.slice(suffixIndex + suffix.length)}`.trim(),
            truncated: false,
        };
    }

    if (prefixIndex !== -1) {
        return {
            reasoning: text.slice(prefixIndex + prefix.length).trim(),
            content: text.slice(0, prefixIndex).trim(),
            truncated: true,
        };
    }

    return { content: text, reasoning: '', truncated: false };
}

/**
 * Prevents chat text from being interpreted as macros when the prompt is assembled.
 * @param {string} text
 * @returns {string}
 */
function escapeMacros(text) {
    return String(text ?? '').replace(/\{\{/g, '{​{');
}

/**
 * Removes the usual out-of-character wrappers from a message (best effort).
 * @param {string} text Message text
 * @returns {string} Text without OOC markers, or the original text if nothing would be left
 */
export function stripOocMarkers(text) {
    const original = String(text ?? '').trim();
    const wrappers = [
        /^\(\(\s*([\s\S]*?)\s*(?:\)\))?$/,
        /^\(\s*(?:\[OOC\]\s*:?|OOC\s*:)\s*([\s\S]*?)\s*\)?$/i,
        /^(?:\[OOC\]\s*:?|OOC\s*:)\s*([\s\S]*)$/i,
    ];

    for (const wrapper of wrappers) {
        const match = original.match(wrapper);
        if (match) {
            const stripped = match[1].trim();
            return stripped || original;
        }
    }

    return original;
}

/**
 * Formats a chat message as a quoted transcript entry.
 * @param {ChatMessage} message
 * @returns {string}
 */
function formatTranscriptEntry(message) {
    const label = message.extra?.ooc ? '[OOC] ' : '';
    const text = `${label}${message.name}: ${message.mes}`;
    return text.split('\n').map(line => `> ${escapeMacros(line)}`).join('\n');
}

/**
 * Assembles the reference document sent to the model.
 * @param {object} sections
 * @param {string} sections.card Character card fields
 * @param {string} sections.persona User persona
 * @param {string} sections.lore Activated World Info
 * @param {string} sections.transcript Quoted transcript
 * @param {boolean} sections.omitted Whether older messages were left out
 * @param {string} sections.question User question
 * @param {string} sections.guidelines Answer guidelines, placed last so they carry the most weight
 * @returns {string}
 */
function buildContextDocument({ card, persona, lore, transcript, omitted, question, guidelines }) {
    const parts = [
        '# Story reference',
        'The following is reference material from an ongoing roleplay between {{user}} and {{char}}. It is provided for context only.',
    ];

    if (card) parts.push(`## Characters\n### {{char}}\n${card}`);
    if (persona) parts.push(`## {{user}}\n${persona}`);
    if (lore) parts.push(`## Lore\n${lore}`);
    if (transcript) parts.push(`## Transcript (most recent last)\n${omitted ? `${OMITTED_MARKER}\n` : ''}${transcript}`);
    parts.push(`# Question from the co-author\n${question}`);
    if (guidelines) parts.push(guidelines);

    return parts.join('\n\n');
}

/**
 * Collects the activated World Info entries for the out-of-character request.
 * @param {ChatMessage[]} messages Messages to scan, oldest first
 * @param {import('../script.js').CharacterCardFields} fields Character card fields
 * @param {number} maxContext Maximum prompt size in tokens
 * @returns {Promise<string>}
 */
async function getOocLore(messages, fields, maxContext) {
    try {
        const chatForWI = messages.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();
        /** @type {import('./world-info.js').WIGlobalScanData} */
        const globalScanData = {
            personaDescription: fields.persona,
            characterDescription: fields.description,
            characterPersonality: fields.personality,
            characterDepthPrompt: fields.charDepthPrompt,
            scenario: fields.scenario,
            creatorNotes: fields.creatorNotes,
            trigger: 'normal',
        };
        const { worldInfoString } = await getWorldInfoPrompt(chatForWI, maxContext, true, globalScanData);
        return String(worldInfoString ?? '').trim();
    } catch (error) {
        console.warn('[OOC] Failed to collect World Info', error);
        return '';
    }
}

/**
 * Builds the out-of-character request for the question at the given chat index.
 * @param {number} questionIndex Index of the user message being answered
 * @returns {Promise<{systemPrompt: string, document: string, responseLength: number|null}>}
 */
async function buildOocRequest(questionIndex) {
    const settings = power_user.ooc;
    const responseLength = Number(settings.response_length) > 0 ? Number(settings.response_length) : null;
    const maxTokens = getMaxPromptTokens(responseLength);

    const question = chat[questionIndex];
    const strippedQuestion = stripOocMarkers(question.mes);
    const questionText = escapeMacros(strippedQuestion);
    const history = chat.slice(0, questionIndex).filter(x => !x.is_system && !x.extra?.[IGNORE_SYMBOL] && typeof x.mes === 'string' && x.mes.trim());

    // The language instruction goes at the end of both the system prompt and the document
    const languageInstruction = getLanguageInstruction(strippedQuestion, history);
    const systemPrompt = `${settings.system_prompt || default_ooc_system_prompt}\n${languageInstruction}`;
    const guidelines = [String(settings.answer_guidelines ?? '').trim(), languageInstruction].filter(Boolean).join('\n');

    const fields = getCharacterCardFields();
    const card = [
        fields.description && `Description: ${fields.description}`,
        fields.personality && `Personality: ${fields.personality}`,
        fields.scenario && `Scenario: ${fields.scenario}`,
    ].filter(Boolean).map(escapeMacros).join('\n');
    const persona = settings.include_persona ? escapeMacros(fields.persona) : '';
    const lore = settings.include_world_info ? escapeMacros(await getOocLore([...history, question], fields, maxTokens)) : '';

    // Drop the least important sections until the fixed part fits
    const budget = Math.floor(maxTokens * (1 - BUDGET_SAFETY_MARGIN));
    const candidates = [
        { card, persona, lore },
        { card, persona, lore: '' },
        { card: '', persona: '', lore: '' },
    ];

    let sections = null;
    let available = 0;
    for (const candidate of candidates) {
        const fixedDocument = buildContextDocument({ ...candidate, transcript: OMITTED_MARKER, omitted: false, question: questionText, guidelines });
        const fixedTokens = await getTokenCountAsync(`${systemPrompt}\n${fixedDocument}`);
        if (fixedTokens <= budget) {
            sections = candidate;
            available = budget - fixedTokens;
            break;
        }
    }

    if (!sections) {
        throw new Error(t`The out-of-character question does not fit in the context size.`);
    }

    if (sections.lore !== lore) {
        console.warn('[OOC] Reference material was trimmed to fit the context size');
    }

    // Fill the transcript from the newest message backwards
    const maxMessages = Number(settings.max_history_messages) > 0 ? Number(settings.max_history_messages) : Infinity;
    const entries = [];
    for (let i = history.length - 1; i >= 0 && entries.length < maxMessages; i--) {
        const entry = formatTranscriptEntry(history[i]);
        const entryTokens = await getTokenCountAsync(`${entry}\n`);
        if (entryTokens > available) {
            break;
        }
        available -= entryTokens;
        entries.unshift(entry);
    }

    const document = buildContextDocument({
        ...sections,
        transcript: entries.join('\n'),
        omitted: entries.length < history.length,
        question: questionText,
        guidelines,
    });

    return { systemPrompt, document, responseLength };
}

/**
 * Generates an out-of-character reply, bypassing the roleplay prompt pipeline.
 * @param {string} type Generation type
 * @param {string} textareaText Text in the send textarea
 * @returns {Promise<string|undefined>} Saved reply text
 */
export async function runOocGeneration(type, textareaText) {
    if (['normal', undefined].includes(type) && textareaText.trim()) {
        $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
        consumeOocArmed();
        await sendMessageAsUser(textareaText, '', null, false, undefined, undefined, { ooc: true });
    } else if (type === 'regenerate' && !chat[chat.length - 1]?.is_user) {
        await deleteLastReplyForRegenerate();
    }

    const questionIndex = type === 'swipe' ? findPreviousMessageIndex(chat.length - 1) : chat.length - 1;
    if (!chat[questionIndex]?.is_user) {
        console.warn('[OOC] No user message to answer');
        return;
    }

    const replyType = type === 'swipe' ? 'swipe' : 'normal';

    try {
        const { systemPrompt, document, responseLength } = await buildOocRequest(questionIndex);
        const prompt = [{ role: 'user', content: document }];

        if (isStreamingEnabled()) {
            const messageId = await streamRawReply({ type: replyType, prompt, systemPrompt, responseLength, extra: { ooc: true } });
            return messageId === null ? undefined : await finalizeStreamedReply(messageId, replyType);
        }

        const reply = await generateRaw({ prompt, systemPrompt, quietToLoud: false, responseLength, trimNames: true });
        const { text, reasoning } = prepareReplyText(String(reply ?? ''));
        if (!text) {
            return;
        }

        const extra = { ooc: true };
        if (reasoning) {
            extra.reasoning_type = ReasoningType.Parsed;
        }

        await saveReply({
            type: replyType,
            getMessage: text,
            reasoning: reasoning ? getRegexedString(reasoning, regex_placement.REASONING) : '',
            extra,
        });
        await saveChatConditional();
        return text;
    } catch (error) {
        if (error?.name !== 'AbortError' && !String(error?.message ?? error).includes('Cancelled')) {
            console.error('[OOC] Generation failed', error);
            toastr.error(String(error?.message ?? error), t`Out-of-character generation failed`);
        }
        throw error;
    }
}

/**
 * Turns a raw model reply into the text of an OOC message: splits the reasoning block,
 * trims an incomplete last sentence and wraps the reply. Warns if nothing is left.
 * @param {string} raw Raw reply
 * @returns {{text: string, reasoning: string}} Reply text (empty if unusable) and reasoning
 */
function prepareReplyText(raw) {
    // The reasoning block must be split before trimming or wrapping the reply
    const { content, reasoning, truncated } = splitReasoning(raw);
    let text = content;
    if (power_user.ooc.trim_incomplete_sentences) {
        // The reply may be cut off by the response length limit
        text = trimToEndSentence(text);
    }

    if (!text) {
        if (truncated) {
            toastr.warning(t`The reply was cut off while the model was still reasoning. Increase the OOC response length.`);
        } else {
            toastr.warning(t`The model returned an empty out-of-character reply.`);
        }
        return { text: '', reasoning };
    }

    if (power_user.ooc.wrap_reply && !/^\(\s*OOC\b/i.test(text)) {
        text = `(OOC: ${text})`;
    }

    return { text, reasoning };
}

/**
 * Applies the OOC post-processing to a reply that has finished streaming.
 * The streaming UI already moved reasoning reported by the API, or parsed by the reasoning auto-parse, out of the text.
 * @param {number} messageId Index of the streamed message
 * @param {string} replyType 'normal' or 'swipe'
 * @returns {Promise<string|undefined>} Saved reply text
 */
async function finalizeStreamedReply(messageId, replyType) {
    const message = chat[messageId];
    if (!message) {
        return;
    }

    const { text, reasoning } = prepareReplyText(String(message.mes ?? ''));
    message.extra ??= {};
    if (reasoning) {
        message.extra.reasoning = getRegexedString(reasoning, regex_placement.REASONING);
        message.extra.reasoning_type = ReasoningType.Parsed;
    }

    if (!text) {
        if (replyType === 'normal' && messageId === chat.length - 1) {
            await deleteLastMessage();
            await saveChatConditional();
        }
        return;
    }

    message.mes = text;
    syncMesToSwipe(messageId);
    updateMessageBlock(messageId, message);
    await saveChatConditional();
    return text;
}

/**
 * Sets whether the next sent message is out of character.
 * @param {boolean} value
 */
export function armOoc(value) {
    oocArmed = !!value;
    $('#mes_ooc').toggleClass('ooc_armed', oocArmed).attr('aria-pressed', String(oocArmed));
    $('#send_textarea').toggleClass('ooc_armed', oocArmed);
}

/**
 * Checks if the next sent message is out of character.
 * @returns {boolean}
 */
export function isOocArmed() {
    return oocArmed;
}

/**
 * Disarms the toggle and returns its previous state.
 * @returns {boolean}
 */
function consumeOocArmed() {
    const value = oocArmed;
    armOoc(false);
    return value;
}

function updateOocButton() {
    const visible = !!power_user.ooc?.enabled && !selected_group;
    $('#mes_ooc').toggleClass('displayNone', !visible);
    if (!visible) {
        armOoc(false);
    }
}

function loadOocSettings() {
    power_user.ooc = Object.assign({}, default_ooc_settings, power_user.ooc);
    if (legacy_ooc_answer_guidelines.includes(power_user.ooc.answer_guidelines)) {
        power_user.ooc.answer_guidelines = default_ooc_answer_guidelines;
        saveSettingsDebounced();
    }

    const checkboxes = ['enabled', 'include_persona', 'include_world_info', 'wrap_reply', 'trim_incomplete_sentences', 'exclude_from_context'];
    for (const key of checkboxes) {
        $(`#ooc_${key}`).prop('checked', power_user.ooc[key]).on('input', function () {
            power_user.ooc[key] = !!$(this).prop('checked');
            if (key === 'enabled') updateOocButton();
            saveSettingsDebounced();
        });
    }

    const textareas = ['system_prompt', 'patterns', 'answer_guidelines'];
    for (const key of textareas) {
        $(`#ooc_${key}`).val(power_user.ooc[key]).on('input', function () {
            power_user.ooc[key] = String($(this).val());
            saveSettingsDebounced();
        });
    }

    const numbers = ['max_history_messages', 'response_length'];
    for (const key of numbers) {
        $(`#ooc_${key}`).val(power_user.ooc[key]).on('input', function () {
            power_user.ooc[key] = Math.max(0, Math.floor(Number($(this).val()) || 0));
            saveSettingsDebounced();
        });
    }

    $('#ooc_system_prompt_restore').on('click', function () {
        power_user.ooc.system_prompt = default_ooc_system_prompt;
        $('#ooc_system_prompt').val(power_user.ooc.system_prompt).trigger('input');
    });

    $('#ooc_answer_guidelines_restore').on('click', function () {
        power_user.ooc.answer_guidelines = default_ooc_answer_guidelines;
        $('#ooc_answer_guidelines').val(power_user.ooc.answer_guidelines).trigger('input');
    });

    $('#ooc_patterns_restore').on('click', function () {
        power_user.ooc.patterns = default_ooc_patterns;
        $('#ooc_patterns').val(power_user.ooc.patterns).trigger('input');
    });
}

export function initOocMode() {
    loadOocSettings();
    updateOocButton();

    $('#mes_ooc').on('click', function () {
        armOoc(!oocArmed);
        $('#send_textarea').trigger('focus');
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        armOoc(false);
        updateOocButton();
    });
}
