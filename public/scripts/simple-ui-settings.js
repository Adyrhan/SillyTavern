/**
 * Settings dialog of the simplified UI.
 *
 * Every control mirrors a control of the classic panels: it reads the classic control's value
 * and writes back by setting it and triggering its event, so all the saving logic is reused.
 */
import {
    event_types,
    eventSource,
    getRequestHeaders,
    getThumbnailUrl,
    main_api,
    name1,
    online_status,
} from '../script.js';
import { t } from './i18n.js';
import { oai_settings } from './openai.js';
import { setPersonaName, user_avatar } from './personas.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { secret_state, SECRET_KEYS } from './secrets.js';
import { getConnectedModelLabel, openAdvancedPanel, refreshChatHeader, setSimpleUiEnabled } from './simple-ui.js';
import { areStyleSamplersSupported, getChatRoleStyle, getDefaultRoleStyle, ROLE_STYLES, setChatRoleStyle, setDefaultRoleStyle } from './simple-ui-styles.js';

/**
 * Closes the settings dialog and opens a classic panel; the panel would be hidden behind the dialog otherwise.
 * @param {Popup} popup
 * @param {string} drawerId
 */
async function openPanelFromSettings(popup, drawerId) {
    await popup.completeCancelled();
    await openAdvancedPanel(drawerId);
}

/**
 * Chat Completion providers offered in the Connection tab. The first one is the default.
 * Selectors point to the classic controls in the API Connections panel.
 */
const PROVIDERS = [
    {
        source: 'custom',
        label: () => t`OpenAI-compatible`,
        hint: () => t`LM Studio, llama.cpp, KoboldCpp, Ollama, vLLM…`,
        key: '#api_key_custom',
        secret: SECRET_KEYS.CUSTOM,
        keyOptional: true,
        url: '#custom_api_url_text',
        model: '#model_custom_select',
        modelInput: '#custom_model_id',
    },
    { source: 'openrouter', label: () => 'OpenRouter', hint: () => t`Hundreds of models with one key`, key: '#api_key_openrouter', secret: SECRET_KEYS.OPENROUTER, model: '#model_openrouter_select' },
    { source: 'openai', label: () => 'OpenAI', hint: () => 'GPT', key: '#api_key_openai', secret: SECRET_KEYS.OPENAI, model: '#model_openai_select' },
    { source: 'claude', label: () => 'Anthropic', hint: () => 'Claude', key: '#api_key_claude', secret: SECRET_KEYS.CLAUDE, model: '#model_claude_select' },
    { source: 'makersuite', label: () => 'Google AI Studio', hint: () => 'Gemini', key: '#api_key_makersuite', secret: SECRET_KEYS.MAKERSUITE, model: '#model_google_select' },
    { source: 'deepseek', label: () => 'DeepSeek', hint: () => 'DeepSeek', key: '#api_key_deepseek', secret: SECRET_KEYS.DEEPSEEK, model: '#model_deepseek_select' },
];

/**
 * Classic drawers reachable from the Advanced tab, in display order.
 * `id` is the `.drawer` wrapper id in index.html.
 */
const ADVANCED_PANELS = [
    { id: 'sys-settings-button', icon: 'fa-plug', label: () => t`API Connections`, hint: () => t`Backend, API keys and models` },
    { id: 'ai-config-button', icon: 'fa-sliders', label: () => t`AI Response Configuration`, hint: () => t`Presets, samplers and context size` },
    { id: 'advanced-formatting-button', icon: 'fa-font', label: () => t`AI Response Formatting`, hint: () => t`Instruct, context and system prompts, OOC mode` },
    { id: 'WI-SP-button', icon: 'fa-book-atlas', label: () => t`World Info`, hint: () => t`Lorebooks and activation settings` },
    { id: 'rightNavHolder', icon: 'fa-address-card', label: () => t`Character Management`, hint: () => t`Edit characters, groups and tags` },
    { id: 'persona-management-button', icon: 'fa-face-smile', label: () => t`Persona Management`, hint: () => t`Your personas and their descriptions` },
    { id: 'user-settings-button', icon: 'fa-user-cog', label: () => t`User Settings`, hint: () => t`Theme, chat display and power user options` },
    { id: 'backgrounds-button', icon: 'fa-panorama', label: () => t`Backgrounds`, hint: () => t`Chat background images` },
    { id: 'extensions-settings-button', icon: 'fa-cubes', label: () => t`Extensions`, hint: () => t`Install and configure extensions` },
];

/**
 * @typedef {object} SettingsTab
 * @property {string} id
 * @property {string} icon Font Awesome icon class
 * @property {() => string} label
 * @property {(pane: JQuery, popup: Popup) => (() => void)|void} render Fills the pane; may return a cleanup function
 */

/** @type {SettingsTab[]} */
const TABS = [
    { id: 'connection', icon: 'fa-plug', label: () => t`Connection`, render: renderConnectionTab },
    { id: 'style', icon: 'fa-masks-theater', label: () => t`Default role style`, render: renderStyleTab },
    { id: 'me', icon: 'fa-user', label: () => t`Me`, render: renderMeTab },
    { id: 'appearance', icon: 'fa-palette', label: () => t`Appearance`, render: renderAppearanceTab },
    { id: 'ooc', icon: 'fa-comment-slash', label: () => t`Out of character`, render: renderOocTab },
    { id: 'advanced', icon: 'fa-screwdriver-wrench', label: () => t`Advanced`, render: renderAdvancedTab },
];

/**
 * Opens the settings dialog.
 * @param {string} [tabId] Tab to show first
 */
export async function openSettings(tabId = 'connection') {
    const content = $(`
        <div class="su-settings">
            <nav class="su-settings-tabs" role="tablist"></nav>
            <div class="su-settings-pane" role="tabpanel"></div>
        </div>
    `);
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', { large: true, allowVerticalScrolling: true });
    popup.dlg.classList.add('su-settings-dialog');
    const nav = content.find('.su-settings-tabs');
    const pane = content.find('.su-settings-pane');
    /** @type {(() => void)|void} */
    let cleanup;

    const showTab = (/** @type {SettingsTab} */ tab) => {
        cleanup?.();
        nav.find('.su-settings-tab').each(function () {
            const selected = $(this).attr('data-tab') === tab.id;
            $(this).toggleClass('selected', selected).attr('aria-selected', String(selected));
        });
        pane.empty().append($('<h3></h3>').text(tab.label()));
        cleanup = tab.render(pane, popup);
    };

    for (const tab of TABS) {
        $('<div class="su-settings-tab" role="tab" tabindex="0"></div>')
            .attr('data-tab', tab.id)
            .append($('<i class="fa-solid fa-fw"></i>').addClass(tab.icon))
            .append($('<span></span>').text(tab.label()))
            .on('click', () => showTab(tab))
            .appendTo(nav);
    }

    showTab(TABS.find(x => x.id === tabId) ?? TABS[0]);
    popup.onClose = () => cleanup?.();
    await popup.show();
}

/**
 * Creates a labelled form field.
 * @param {string} label
 * @param {JQuery} control
 * @param {string} [hint]
 * @returns {JQuery}
 */
function field(label, control, hint = '') {
    const wrapper = $('<label class="su-field"></label>')
        .append($('<span class="su-field-label"></span>').text(label))
        .append(control);
    if (hint) {
        wrapper.append($('<small class="su-field-hint"></small>').text(hint));
    }
    return wrapper;
}

/**
 * Creates a checkbox mirroring a classic checkbox.
 * @param {string} classicSelector
 * @param {string} label
 * @param {string} [hint]
 * @returns {JQuery}
 */
function mirroredCheckbox(classicSelector, label, hint = '') {
    const classic = $(classicSelector);
    const input = $('<input type="checkbox">').prop('checked', classic.prop('checked'));
    input.on('change', () => classic.prop('checked', input.prop('checked')).trigger('input').trigger('change'));
    const wrapper = $('<label class="checkbox_label su-check"></label>')
        .append(input)
        .append($('<span></span>').text(label));
    if (hint) {
        return $('<div></div>').append(wrapper).append($('<small class="su-field-hint"></small>').text(hint));
    }
    return wrapper;
}

/**
 * Creates a select mirroring a classic select, with its options copied over.
 * @param {string} classicSelector
 * @returns {JQuery}
 */
function mirroredSelect(classicSelector) {
    const classic = $(classicSelector);
    const select = $('<select class="text_pole"></select>').html(classic.html()).val(String(classic.val() ?? ''));
    select.on('change', () => classic.val(String(select.val())).trigger('change'));
    return select;
}

// ---------- Connection ----------

/**
 * @returns {typeof PROVIDERS[number]} Provider currently configured in the classic panel, or the default one
 */
function getActiveProvider() {
    if (main_api === 'openai') {
        const provider = PROVIDERS.find(x => x.source === oai_settings.chat_completion_source);
        if (provider) {
            return provider;
        }
    }
    return PROVIDERS[0];
}

/**
 * Points the classic API Connections panel at a provider and connects.
 * @param {typeof PROVIDERS[number]} p
 * @param {object} values
 * @param {string} [values.url] Server base URL, for providers that have one
 * @param {string} [values.key] API key; an empty key keeps the saved one
 * @param {string} [values.model] Model ID
 */
function connectProvider(p, { url, key, model }) {
    if (main_api !== 'openai') {
        $('#main_api').val('openai').trigger('change');
    }
    if (oai_settings.chat_completion_source !== p.source) {
        $('#chat_completion_source').val(p.source).trigger('change');
    }
    if (p.url && url !== undefined) {
        $(p.url).val(url.trim()).trigger('input');
    }
    if (key?.trim()) {
        $(p.key).val(key.trim());
    }
    if (model?.trim()) {
        if (p.modelInput) {
            $(p.modelInput).val(model.trim()).trigger('input');
        } else {
            $(p.model).val(model.trim()).trigger('change');
        }
    }
    $('#api_button_openai').trigger('click');
}

/**
 * Section that looks for inference servers running on this computer and connects to one in a click.
 * @param {object} options
 * @param {boolean} options.autoRun Search right away
 * @returns {JQuery}
 */
function renderLocalDetection({ autoRun }) {
    const box = $('<div class="su-detect"></div>');
    const custom = PROVIDERS.find(x => x.source === 'custom');

    const renderIdle = () => {
        box.empty().append(
            $('<div class="su-detect-text"></div>')
                .append($('<i class="fa-solid fa-computer"></i>'))
                .append($('<span></span>').text(t`Running the AI on this computer?`)),
            $('<div class="menu_button" tabindex="0" role="button"></div>')
                .append($('<i class="fa-solid fa-magnifying-glass"></i>'), $('<span></span>').text(t`Find it`))
                .on('click', run),
        );
    };

    const renderResults = (/** @type {{engine: string, label: string, baseUrl: string, models: string[]}[]} */ backends) => {
        box.empty();
        if (backends.length === 0) {
            box.append(
                $('<div class="su-detect-text"></div>')
                    .append($('<i class="fa-solid fa-circle-info"></i>'))
                    .append($('<span></span>').text(t`No AI server found on this computer. Start LM Studio, KoboldCpp, Ollama or llama.cpp and search again.`)),
                $('<div class="menu_button" tabindex="0" role="button"></div>')
                    .append($('<i class="fa-solid fa-rotate"></i>'), $('<span></span>').text(t`Search again`))
                    .on('click', run),
            );
            return;
        }

        box.append($('<div class="su-detect-text"></div>')
            .append($('<i class="fa-solid fa-circle-check"></i>'))
            .append($('<span></span>').text(t`Found on this computer:`)));
        for (const backend of backends) {
            const models = $('<select class="text_pole"></select>');
            for (const model of backend.models) {
                models.append($('<option></option>').val(model).text(model));
            }
            if (backend.models.length === 0) {
                models.append($('<option value=""></option>').text(t`No model loaded`));
            }
            const useButton = $('<div class="menu_button su-primary" tabindex="0" role="button"></div>')
                .append($('<i class="fa-solid fa-plug"></i>'), $('<span></span>').text(t`Use`))
                .on('click', () => connectProvider(custom, { url: backend.baseUrl, model: String(models.val() ?? '') }));
            box.append($('<div class="su-detect-row"></div>').append(
                $('<div class="su-detect-name"></div>')
                    .append($('<b></b>').text(backend.label))
                    .append($('<small></small>').text(backend.baseUrl)),
                models,
                useButton,
            ));
        }
    };

    async function run() {
        box.empty().append($('<div class="su-detect-text"></div>')
            .append($('<i class="fa-solid fa-spinner fa-spin"></i>'))
            .append($('<span></span>').text(t`Looking for AI servers on this computer…`)));
        try {
            const response = await fetch('/api/backends/autodetect', { method: 'POST', headers: getRequestHeaders() });
            const data = response.ok ? await response.json() : { backends: [] };
            renderResults(Array.isArray(data?.backends) ? data.backends : []);
        } catch (error) {
            console.error('Local AI detection failed', error);
            renderResults([]);
        }
    }

    if (autoRun) {
        void run();
    } else {
        renderIdle();
    }
    return box;
}

/**
 * @param {JQuery} pane
 * @param {Popup} popup
 */
function renderConnectionTab(pane, popup) {
    const status = $('<div class="su-connection-status"></div>');
    const cards = $('<div class="su-provider-grid"></div>');
    const form = $('<div class="su-provider-form"></div>');
    let provider = getActiveProvider();

    const isActive = (/** @type {typeof provider} */ p) => main_api === 'openai' && oai_settings.chat_completion_source === p.source;

    const renderStatus = () => {
        const model = getConnectedModelLabel();
        status.toggleClass('connected', !!model).empty()
            .append($('<i class="fa-solid fa-circle"></i>'))
            .append($('<span></span>').text(model ? t`Connected to ${model}` : t`Not connected`));
        if (main_api !== 'openai') {
            status.append($('<small></small>').text(t`You are using a backend from the advanced settings. Connecting here will switch to the selected provider.`));
        }
    };

    const renderCards = () => {
        cards.empty();
        for (const p of PROVIDERS) {
            $('<div class="su-provider" tabindex="0" role="button"></div>')
                .toggleClass('selected', p === provider)
                .toggleClass('active', isActive(p))
                .append($('<div class="su-provider-name"></div>').text(p.label()))
                .append($('<div class="su-provider-hint"></div>').text(p.hint()))
                .on('click', () => {
                    provider = p;
                    renderCards();
                    renderForm();
                })
                .appendTo(cards);
        }
        $('<div class="su-provider su-provider-other" tabindex="0" role="button"></div>')
            .append($('<div class="su-provider-name"></div>').text(t`Other backends…`))
            .append($('<div class="su-provider-hint"></div>').text(t`Text Completion, NovelAI, Horde…`))
            .on('click', () => openPanelFromSettings(popup, 'sys-settings-button'))
            .appendTo(cards);
    };

    const renderForm = () => {
        const p = provider;
        form.empty();

        /** @type {JQuery|null} */
        let urlInput = null;
        if (p.url) {
            urlInput = $('<input class="text_pole" type="url" autocomplete="off" placeholder="http://127.0.0.1:1234/v1">').val(String($(p.url).val() ?? ''));
            form.append(field(t`Server address`, urlInput, t`The base URL of the server, usually ending in /v1.`));
        }

        const keySaved = !!secret_state[p.secret];
        const keyInput = $('<input class="text_pole" type="password" autocomplete="off">')
            .attr('placeholder', keySaved ? t`Key saved` : (p.keyOptional ? t`Optional` : ''));
        form.append(field(p.keyOptional ? t`API key (optional)` : t`API key`, keyInput));

        // Models are only listed for the provider currently set in the classic panel.
        const modelSelect = $('<select class="text_pole"></select>');
        if (isActive(p) || !p.modelInput) {
            modelSelect.html($(p.model).html()).val(String($(p.model).val() ?? ''));
        }
        /** @type {JQuery|null} */
        let modelInput = null;
        if (p.modelInput) {
            modelInput = $('<input class="text_pole" type="text" autocomplete="off">').attr('placeholder', t`Connect to see the available models`);
            if (isActive(p)) {
                modelInput.val(String($(p.modelInput).val() ?? ''));
            }
            modelSelect.on('change', () => modelInput.val(String(modelSelect.val() ?? '')));
            form.append(field(t`Model`, $('<div class="su-model-row"></div>').append(modelInput).append(modelSelect.toggleClass('displayNone', modelSelect.find('option').length < 2))));
        } else {
            form.append(field(t`Model`, modelSelect));
        }

        const connectButton = $('<div class="menu_button su-primary" tabindex="0" role="button"></div>')
            .append($('<i class="fa-solid fa-plug"></i>'))
            .append($('<span></span>').text(t`Connect`));
        form.append($('<div class="su-actions"></div>').append(connectButton));

        connectButton.on('click', () => connectProvider(p, {
            url: urlInput ? String(urlInput.val()) : undefined,
            key: String(keyInput.val()),
            model: String((modelInput ?? modelSelect).val() ?? ''),
        }));
    };

    const onStatusChanged = () => {
        renderStatus();
        renderCards();
        renderForm();
    };
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, onStatusChanged);

    renderStatus();
    renderCards();
    renderForm();
    pane.append(
        status,
        renderLocalDetection({ autoRun: online_status === 'no_connection' }),
        $('<div class="su-field-label"></div>').text(t`Provider`),
        cards,
        form,
    );

    return () => eventSource.removeListener(event_types.ONLINE_STATUS_CHANGED, onStatusChanged);
}

// ---------- Role style ----------

/**
 * Creates a row of mutually exclusive options.
 * @param {string} label
 * @param {{ value: string, label: string }[]} options
 * @param {string|null} selected
 * @param {(value: string) => void} onSelect
 * @returns {JQuery}
 */
function segmented(label, options, selected, onSelect) {
    const group = $('<div class="su-segmented" role="radiogroup"></div>').attr('aria-label', label);
    for (const option of options) {
        $('<div class="su-segment" role="radio" tabindex="0"></div>')
            .text(option.label)
            .toggleClass('selected', option.value === selected)
            .attr('aria-checked', String(option.value === selected))
            .on('click', () => onSelect(option.value))
            .appendTo(group);
    }
    return field(label, group);
}

/**
 * Renders the role style cards and the length and creativity selectors.
 * @param {JQuery} container
 * @param {() => import('./simple-ui-styles.js').RoleStyleChoice|{style: undefined}} getChoice
 * @param {(choice: import('./simple-ui-styles.js').RoleStyleChoice) => void} setChoice
 */
function renderRoleStylePicker(container, getChoice, setChoice) {
    const render = () => {
        const choice = getChoice();
        const update = (/** @type {Partial<import('./simple-ui-styles.js').RoleStyleChoice>} */ changes) => {
            setChoice({ ...choice, ...changes });
            render();
        };

        const grid = $('<div class="su-style-grid"></div>');
        const cards = [
            ...ROLE_STYLES.map(style => ({ id: style.id, icon: style.icon, label: style.label(), description: style.description(), style })),
            { id: null, icon: 'fa-pen-nib', label: t`No style`, description: t`Only your own prompt from the advanced settings.`, style: null },
        ];
        for (const card of cards) {
            $('<div class="su-style-card" tabindex="0" role="button"></div>')
                .toggleClass('selected', choice.style === card.id)
                .toggleClass('su-style-none', card.id === null)
                .append($('<i class="fa-solid fa-fw su-style-icon"></i>').addClass(card.icon))
                .append($('<div class="su-provider-name"></div>').text(card.label))
                .append($('<div class="su-style-description"></div>').text(card.description))
                .on('click', () => update(card.style
                    ? { style: card.style.id, length: card.style.length, creativity: card.style.creativity }
                    : { style: null }))
                .appendTo(grid);
        }

        container.empty().append(
            grid,
            segmented(t`Reply length`, [
                { value: 'short', label: t`Short` },
                { value: 'medium', label: t`Medium` },
                { value: 'long', label: t`Long` },
            ], choice.length, (length) => update({ length: /** @type {any} */ (length) })),
            segmented(t`Creativity`, [
                { value: 'low', label: t`Predictable` },
                { value: 'medium', label: t`Balanced` },
                { value: 'high', label: t`Inventive` },
            ], choice.creativity, (creativity) => update({ creativity: /** @type {any} */ (creativity) })),
        );
        if (!areStyleSamplersSupported()) {
            container.append($('<small class="su-field-hint"></small>').text(t`Reply length and creativity only apply to Chat Completion and Text Completion backends.`));
        }
    };
    render();
}

/**
 * Opens the role style picker for the open chat.
 */
export async function openChatRoleStyle() {
    const body = $('<div class="su-style-body"></div>');
    const content = $('<div class="su-chat-style"></div>').append(
        $('<h3></h3>').text(t`Role style of this story`),
        $('<p class="su-settings-note"></p>').text(t`Each story keeps its own style. It sets how the AI writes, how long its replies are and how inventive it gets.`),
        body,
    );
    // A chat without a style shows nothing selected, with the default length and creativity.
    renderRoleStylePicker(body, () => getChatRoleStyle() ?? { ...getDefaultRoleStyle(), style: undefined }, (choice) => {
        setChatRoleStyle(choice);
        refreshChatHeader();
    });
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', { wide: true, allowVerticalScrolling: true });
    popup.dlg.classList.add('su-settings-dialog');
    await popup.show();
}

/**
 * @param {JQuery} pane
 */
function renderStyleTab(pane) {
    const body = $('<div class="su-style-body"></div>');
    pane.append(
        $('<p class="su-settings-note"></p>').text(t`The style new stories start with. Each story keeps its own style, which you can change from the button next to the character name.`),
        body,
    );
    renderRoleStylePicker(body, getDefaultRoleStyle, setDefaultRoleStyle);
}

// ---------- Me ----------

/**
 * @param {JQuery} pane
 * @param {Popup} popup
 */
function renderMeTab(pane, popup) {
    const avatar = $('<img class="su-avatar su-avatar-large" alt="">').attr('src', getThumbnailUrl('persona', user_avatar));
    const changeAvatar = $('<div class="menu_button" tabindex="0" role="button"></div>').text(t`Change picture`);
    changeAvatar.on('click', () => $('#persona_set_image_button').trigger('click'));

    const nameInput = $('<input class="text_pole" type="text" autocomplete="off">').val(name1);
    nameInput.on('change', async () => {
        const name = String(nameInput.val()).trim();
        if (name && name !== name1) {
            await setPersonaName(user_avatar, name);
        }
    });

    const description = $('<textarea class="text_pole" rows="6"></textarea>')
        .attr('placeholder', t`Who are you in the story? Appearance, personality, background…`)
        .val(String($('#persona_description').val() ?? ''));
    description.on('input', () => $('#persona_description').val(String(description.val())).trigger('input'));

    const onAvatarChanged = () => avatar.attr('src', `${getThumbnailUrl('persona', user_avatar)}&t=${Date.now()}`);
    eventSource.on(event_types.PERSONA_CHANGED, onAvatarChanged);
    eventSource.on(event_types.SETTINGS_UPDATED, onAvatarChanged);

    pane.append(
        $('<div class="su-me-header"></div>').append(avatar, changeAvatar),
        field(t`Your name`, nameInput, t`How the characters will call you.`),
        field(t`About you`, description, t`Optional. The AI uses this to know who you are.`),
        $('<div class="su-link" tabindex="0" role="button"></div>')
            .text(t`Manage several personas`)
            .on('click', () => openPanelFromSettings(popup, 'persona-management-button')),
    );

    return () => {
        eventSource.removeListener(event_types.PERSONA_CHANGED, onAvatarChanged);
        eventSource.removeListener(event_types.SETTINGS_UPDATED, onAvatarChanged);
    };
}

// ---------- Appearance ----------

/**
 * @param {JQuery} pane
 * @param {Popup} popup
 */
function renderAppearanceTab(pane, popup) {
    const fontScale = $('<input type="range" min="0.8" max="1.4" step="0.05">').val(String($('#font_scale').val() ?? '1'));
    fontScale.on('input', () => $('#font_scale').val(String(fontScale.val())).trigger('input', { forced: true }));

    pane.append(
        field(t`Theme`, mirroredSelect('#themes')),
        field(t`Chat style`, mirroredSelect('#chat_display')),
        field(t`Text size`, fontScale),
        field(t`Language`, mirroredSelect('#ui_language_select'), t`Changing the language reloads the page.`),
        $('<div class="su-actions"></div>').append(
            $('<div class="menu_button" tabindex="0" role="button"></div>')
                .append($('<i class="fa-solid fa-panorama"></i>'), $('<span></span>').text(t`Choose background`))
                .on('click', () => openPanelFromSettings(popup, 'backgrounds-button')),
        ),
    );
}

// ---------- Out of character ----------

/**
 * @param {JQuery} pane
 * @param {Popup} popup
 */
function renderOocTab(pane, popup) {
    pane.append(
        $('<p class="su-settings-note"></p>').text(t`Talk to the AI outside of the story: ask about the plot, request changes or clarify things. Use the "Out of character" button next to the message box.`),
        mirroredCheckbox('#ooc_enabled', t`Enable out-of-character messages`),
        mirroredCheckbox('#ooc_exclude_from_context', t`Keep them out of the story`, t`The AI won't see out-of-character messages when continuing the roleplay.`),
        mirroredCheckbox('#ooc_include_world_info', t`Include World Info in the answers`),
        $('<div class="su-link" tabindex="0" role="button"></div>')
            .text(t`Edit the out-of-character prompts`)
            .on('click', () => openPanelFromSettings(popup, 'advanced-formatting-button')),
    );
}

// ---------- Advanced ----------

/**
 * @param {JQuery} pane
 * @param {Popup} popup
 */
function renderAdvancedTab(pane, popup) {
    const list = $('<div class="su-settings-list"></div>');
    for (const panel of ADVANCED_PANELS) {
        $('<div class="su-settings-entry" tabindex="0" role="button"></div>')
            .append($('<i class="fa-solid fa-fw su-item-icon"></i>').addClass(panel.icon))
            .append($('<div class="su-item-text"></div>')
                .append($('<div class="su-item-name"></div>').text(panel.label()))
                .append($('<div class="su-item-sub"></div>').text(panel.hint())))
            .on('click', () => openPanelFromSettings(popup, panel.id))
            .appendTo(list);
    }

    const classic = $('<label class="checkbox_label su-check"></label>')
        .append($('<input type="checkbox">').on('change', async () => {
            await popup.completeCancelled();
            setSimpleUiEnabled(false);
        }))
        .append($('<span></span>').text(t`Use the classic interface (top bar)`));

    pane.append(
        $('<p class="su-settings-note"></p>').text(t`The full settings panels, for fine-tuning every detail.`),
        list,
        $('<hr>'),
        classic,
    );
}
