/**
 * Role styles of the simplified UI: ready-made combinations of a prompt, a response length and
 * a temperature for common kinds of roleplay.
 *
 * Each chat keeps its own style in its metadata. While a chat is open, its style prompt is injected
 * as an extension prompt (the user's own prompts are left untouched) and its length and creativity
 * are applied to the response length and temperature controls. New chats get the default style.
 */
import {
    amount_gen,
    chat,
    chat_metadata,
    event_types,
    eventSource,
    extension_prompt_types,
    getCurrentChatId,
    main_api,
    setExtensionPrompt,
} from '../script.js';
import { saveMetadataDebounced } from './extensions.js';
import { t } from './i18n.js';
import { oai_settings } from './openai.js';
import { textgenerationwebui_settings } from './textgen-settings.js';
import { accountStorage } from './util/AccountStorage.js';

const METADATA_KEY = 'simple_ui_role_style';
const DEFAULT_STORAGE_KEY = 'SimpleUiDefaultRoleStyle';
const INJECTION_KEY = 'SIMPLE_UI_ROLE_STYLE';

const NO_USER_ACTIONS = 'Never write {{user}}\'s actions, dialogue or thoughts.';
const SAME_LANGUAGE = 'Write in the language of the conversation.';

/**
 * @typedef {'short'|'medium'|'long'} RoleStyleLength
 * @typedef {'low'|'medium'|'high'} RoleStyleCreativity
 *
 * @typedef {object} RoleStyle
 * @property {string} id
 * @property {string} icon Font Awesome icon class
 * @property {() => string} label
 * @property {() => string} description
 * @property {RoleStyleLength} length Default response length
 * @property {RoleStyleCreativity} creativity Default creativity
 * @property {string} prompt Instructions for the model, in English since models follow it best
 *
 * @typedef {object} RoleStyleChoice What a chat (or the default for new chats) uses
 * @property {string|null} style Role style ID, or null for no style prompt
 * @property {RoleStyleLength} length
 * @property {RoleStyleCreativity} creativity
 */

/** @type {RoleStyle[]} */
export const ROLE_STYLES = [
    {
        id: 'action',
        icon: 'fa-bolt',
        label: () => t`Action`,
        description: () => t`Fast pace, fights and dangers with real consequences.`,
        length: 'short',
        creativity: 'medium',
        prompt: `You are {{char}} in a fast-paced action roleplay with {{user}}. Keep the story moving with vivid, punchy descriptions of movement, danger and impact. Every action has clear, believable consequences, and enemies and obstacles push back. End your reply at a moment that invites {{user}} to act. ${NO_USER_ACTIONS} ${SAME_LANGUAGE}`,
    },
    {
        id: 'adventure',
        icon: 'fa-dragon',
        label: () => t`Adventure`,
        description: () => t`Fantasy and exploration, rich descriptions of a living world.`,
        length: 'medium',
        creativity: 'medium',
        prompt: `You are {{char}}, and together with {{user}} you are telling an adventure story. Narrate in third person with rich sensory detail about places, creatures and weather. Make the world feel alive: introduce discoveries, mysteries and choices, and stay true to {{char}}'s personality. ${NO_USER_ACTIONS} ${SAME_LANGUAGE}`,
    },
    {
        id: 'companion',
        icon: 'fa-mug-hot',
        label: () => t`Companion`,
        description: () => t`A natural conversation, short and close replies.`,
        length: 'short',
        creativity: 'medium',
        prompt: `You are {{char}}, talking with {{user}}. Reply in first person, the way {{char}} would naturally speak: warm, attentive and in character. Keep replies short and conversational, with only light descriptions of gestures or expressions, and show genuine interest in what {{user}} says. Never speak for {{user}}. ${SAME_LANGUAGE}`,
    },
    {
        id: 'narrator',
        icon: 'fa-dice-d20',
        label: () => t`Game master`,
        description: () => t`The AI runs the story, the world and every other character.`,
        length: 'long',
        creativity: 'high',
        prompt: `You are the narrator and game master of an interactive story with {{user}}. Describe the scene, voice {{char}} and any other characters, and keep track of the world, its rules and the consequences of every choice. Offer hooks, complications and meaningful decisions, but let {{user}} decide what their character does. ${NO_USER_ACTIONS} ${SAME_LANGUAGE}`,
    },
    {
        id: 'romance',
        icon: 'fa-heart',
        label: () => t`Romance`,
        description: () => t`Slice of life, emotions and a relationship that grows.`,
        length: 'medium',
        creativity: 'medium',
        prompt: `You are {{char}} in a romance and slice-of-life story with {{user}}. Focus on emotions, small everyday moments, body language and the slow development of the relationship. Keep {{char}} consistent, with their own wishes, doubts and boundaries. ${NO_USER_ACTIONS} ${SAME_LANGUAGE}`,
    },
];

/** Response length in tokens. */
export const LENGTH_TOKENS = { short: 250, medium: 450, long: 750 };

/** Sampling temperature. */
export const CREATIVITY_TEMPERATURE = { low: 0.7, medium: 0.9, high: 1.1 };

/** @type {RoleStyleChoice} */
const FALLBACK_DEFAULT = { style: 'adventure', length: 'medium', creativity: 'medium' };

/**
 * @param {string|null} id
 * @returns {RoleStyle|null}
 */
export function findRoleStyle(id) {
    return ROLE_STYLES.find(x => x.id === id) ?? null;
}

/**
 * Validates a stored choice, dropping unknown values.
 * @param {any} value
 * @returns {RoleStyleChoice|null}
 */
function parseChoice(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return {
        style: findRoleStyle(value.style) ? value.style : null,
        length: value.length in LENGTH_TOKENS ? value.length : 'medium',
        creativity: value.creativity in CREATIVITY_TEMPERATURE ? value.creativity : 'medium',
    };
}

/**
 * Checks if length and creativity can be applied to the current backend.
 * The style prompt itself works with every backend.
 * @returns {boolean}
 */
export function areStyleSamplersSupported() {
    return main_api === 'openai' || main_api === 'textgenerationwebui';
}

/**
 * @returns {RoleStyleChoice} Style given to new chats
 */
export function getDefaultRoleStyle() {
    try {
        return parseChoice(JSON.parse(accountStorage.getItem(DEFAULT_STORAGE_KEY) ?? 'null')) ?? { ...FALLBACK_DEFAULT };
    } catch {
        return { ...FALLBACK_DEFAULT };
    }
}

/**
 * @param {RoleStyleChoice} choice
 */
export function setDefaultRoleStyle(choice) {
    accountStorage.setItem(DEFAULT_STORAGE_KEY, JSON.stringify(choice));
}

/**
 * @returns {RoleStyleChoice|null} Style of the open chat, or null if it never got one
 */
export function getChatRoleStyle() {
    return parseChoice(chat_metadata?.[METADATA_KEY]);
}

/**
 * Saves the style of the open chat and applies it.
 * @param {RoleStyleChoice} choice
 */
export function setChatRoleStyle(choice) {
    if (!getCurrentChatId()) {
        return;
    }
    chat_metadata[METADATA_KEY] = choice;
    saveMetadataDebounced();
    applyChatRoleStyle();
}

/**
 * Injects the style prompt of the open chat and applies its length and creativity.
 */
function applyChatRoleStyle() {
    const choice = getCurrentChatId() ? getChatRoleStyle() : null;
    const style = findRoleStyle(choice?.style ?? null);
    setExtensionPrompt(INJECTION_KEY, style?.prompt ?? '', extension_prompt_types.BEFORE_PROMPT, 0);

    // Chats without a style keep whatever the advanced settings say.
    if (!choice) {
        return;
    }

    const maxTokens = LENGTH_TOKENS[choice.length];
    const temperature = CREATIVITY_TEMPERATURE[choice.creativity];
    if (main_api === 'openai') {
        if (Number(oai_settings.temp_openai) !== temperature) {
            $('#temp_openai').val(temperature).trigger('input');
        }
        if (Number(oai_settings.openai_max_tokens) !== maxTokens) {
            $('#openai_max_tokens').val(maxTokens).trigger('input');
        }
    } else if (main_api === 'textgenerationwebui') {
        if (Number(textgenerationwebui_settings.temp) !== temperature) {
            $('#temp_textgenerationwebui').val(temperature).trigger('input');
        }
        if (Number(amount_gen) !== maxTokens) {
            $('#amount_gen').val(maxTokens).trigger('input');
        }
    }
}

function onChatChanged() {
    // A chat the user hasn't written in yet is new: give it the default style.
    if (getCurrentChatId() && !getChatRoleStyle() && !chat.some(message => message.is_user)) {
        chat_metadata[METADATA_KEY] = getDefaultRoleStyle();
        saveMetadataDebounced();
    }
    applyChatRoleStyle();
}

/**
 * Registers the handlers that keep the role style in sync with the open chat.
 * Must run before other CHAT_CHANGED handlers that display the style.
 */
export function initRoleStyles() {
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MAIN_API_CHANGED, applyChatRoleStyle);
}
