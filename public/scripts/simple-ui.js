/**
 * Simplified UI shell.
 *
 * Replaces the top drawer bar with a sidebar (recent chats and characters), a chat header
 * and a settings dialog. The classic drawers stay in the DOM and keep working; they are
 * only reachable from the settings dialog, where they open as a full-height overlay.
 */
import {
    characters,
    chat,
    doNavbarIconClick,
    doNewChat,
    event_types,
    eventSource,
    getCurrentChatId,
    getThumbnailUrl,
    main_api,
    name1,
    name2,
    online_status,
    selectCharacterById,
    system_avatar,
    this_chid,
} from '../script.js';
import { getGroupAvatar, groups, selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { user_avatar } from './personas.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { accountStorage } from './util/AccountStorage.js';
import { debounce } from './utils.js';
import { getRecentChats, openRecentCharacterChat, openRecentGroupChat } from './welcome-screen.js';
import { armOoc } from './ooc.js';
import { getChatCompletionModel } from './openai.js';
import { openChatRoleStyle, openSettings } from './simple-ui-settings.js';
import { findRoleStyle, getChatRoleStyle, initRoleStyles } from './simple-ui-styles.js';

const DISABLED_STORAGE_KEY = 'SimpleUiDisabled';
const MAX_RECENT_CHATS = 6;

/**
 * @returns {string} Name of the model in use, or an empty string when not connected
 */
export function getConnectedModelLabel() {
    if (online_status === 'no_connection') {
        return '';
    }
    // Chat Completion reports a generic status such as "Valid" for some sources.
    return (main_api === 'openai' && getChatCompletionModel()) || online_status;
}

/**
 * Checks if the simplified UI is active.
 * @returns {boolean}
 */
export function isSimpleUi() {
    return document.body.classList.contains('simple-ui');
}

/**
 * Opens a classic drawer as a full-height overlay.
 * @param {string} drawerId Id of the `.drawer` wrapper element
 */
export async function openAdvancedPanel(drawerId) {
    const drawer = document.getElementById(drawerId);
    const toggle = drawer?.querySelector(':scope > .drawer-toggle');
    if (!toggle) {
        return;
    }
    closeSidebar();
    setAdvancedTitle(toggle);
    // Let the triggering click finish bubbling first: the document click handler in script.js
    // closes any drawer that was not the click target.
    await new Promise(resolve => setTimeout(resolve));
    if (!drawer.querySelector('.drawer-content')?.classList.contains('openDrawer')) {
        await doNavbarIconClick.call(toggle);
    }
}

/**
 * Closes any classic drawer that is open.
 */
export async function closeAdvancedPanels() {
    const openDrawers = document.querySelectorAll('#top-settings-holder .drawer-content.openDrawer');
    for (const content of openDrawers) {
        const toggle = content.closest('.drawer')?.querySelector(':scope > .drawer-toggle');
        if (toggle) {
            await doNavbarIconClick.call(toggle);
        }
    }
}

/**
 * @param {Element} toggle Drawer toggle whose icon title names the panel
 */
function setAdvancedTitle(toggle) {
    const title = toggle.querySelector('.drawer-icon')?.getAttribute('title') ?? '';
    $('#su-advanced-title').text(title);
}

function openSidebar() {
    document.body.classList.add('su-sidebar-open');
}

function closeSidebar() {
    document.body.classList.remove('su-sidebar-open');
}

/**
 * Creates an avatar image element.
 * @param {string} src Image URL
 * @param {string} [className] Extra class
 * @returns {JQuery<HTMLImageElement>}
 */
function avatarImg(src, className = '') {
    return $('<img loading="lazy" alt="">').attr('src', src).addClass(`su-avatar ${className}`);
}

function buildSidebar() {
    const sidebar = $(`
        <aside id="su-sidebar">
            <div class="su-sidebar-top">
                <div class="su-brand"><i class="fa-solid fa-mug-hot"></i><span>SillyTavern</span></div>
                <div id="su-new-story" class="menu_button su-primary" tabindex="0" role="button">
                    <i class="fa-solid fa-plus"></i><span>${t`New story`}</span>
                </div>
                <input id="su-search" class="text_pole" type="search" autocomplete="off" placeholder="${t`Search characters`}">
            </div>
            <div class="su-sidebar-scroll">
                <div class="su-section" id="su-recent-section">
                    <div class="su-section-title">${t`Recent`}</div>
                    <div id="su-recent" class="su-list"></div>
                </div>
                <div class="su-section">
                    <div class="su-section-title">
                        <span>${t`Characters`}</span>
                        <i id="su-import" class="fa-solid fa-file-import su-icon-button" tabindex="0" role="button" title="${t`Import character`}"></i>
                        <i id="su-create" class="fa-solid fa-user-plus su-icon-button" tabindex="0" role="button" title="${t`Create character`}"></i>
                    </div>
                    <div id="su-characters" class="su-list"></div>
                </div>
            </div>
            <div class="su-sidebar-footer">
                <div id="su-persona" class="su-item" tabindex="0" role="button" title="${t`Your persona`}"></div>
                <div id="su-settings" class="su-item" tabindex="0" role="button">
                    <i class="fa-solid fa-gear su-item-icon"></i><span>${t`Settings`}</span>
                </div>
            </div>
        </aside>
        <div id="su-sidebar-backdrop"></div>
    `);
    $('body').append(sidebar);

    $('#su-new-story').on('click', () => openNewStoryPicker());
    $('#su-search').on('input', debounce(() => renderCharacters(), 100));
    $('#su-import').on('click', () => $('#character_import_button').trigger('click'));
    $('#su-create').on('click', async () => {
        await openAdvancedPanel('rightNavHolder');
        $('#rm_button_create').trigger('click');
    });
    $('#su-persona').on('click', () => openSettings('me'));
    $('#su-settings').on('click', () => {
        closeSidebar();
        void openSettings();
    });
    $('#su-sidebar-backdrop').on('click', () => closeSidebar());
}

function buildChatHeader() {
    const header = $(`
        <div id="su-chat-header">
            <i id="su-menu-toggle" class="fa-solid fa-bars su-icon-button" tabindex="0" role="button" title="${t`Menu`}"></i>
            <div id="su-header-avatar"></div>
            <div class="su-header-text">
                <div id="su-header-name"></div>
                <div id="su-header-sub"></div>
            </div>
            <div id="su-style-chip" class="su-pill su-style-chip" tabindex="0" role="button" title="${t`Role style of this story`}"></div>
            <div id="su-connection" class="su-pill" tabindex="0" role="button"></div>
            <i id="su-header-card" class="fa-solid fa-address-card su-icon-button" tabindex="0" role="button" title="${t`Character card`}"></i>
            <i id="su-header-world" class="fa-solid fa-book-atlas su-icon-button" tabindex="0" role="button" title="${t`World Info`}"></i>
            <div class="su-menu-anchor">
                <i id="su-header-more" class="fa-solid fa-ellipsis-vertical su-icon-button" tabindex="0" role="button" title="${t`More`}"></i>
                <div id="su-header-menu" class="su-dropdown"></div>
            </div>
        </div>
    `);
    $('#sheld').prepend(header);

    const menuItems = [
        { option: 'option_start_new_chat', icon: 'fa-comments', label: t`Start new chat` },
        { option: 'option_select_chat', icon: 'fa-address-book', label: t`Previous chats` },
        { option: 'option_regenerate', icon: 'fa-repeat', label: t`Regenerate` },
        { option: 'option_impersonate', icon: 'fa-user-secret', label: t`Write my reply` },
        { option: 'option_toggle_AN', icon: 'fa-note-sticky', label: t`Author's Note` },
        { option: 'option_delete_mes', icon: 'fa-trash-can', label: t`Delete messages` },
        { option: 'option_close_chat', icon: 'fa-times', label: t`Close chat` },
    ];
    const menu = $('#su-header-menu');
    for (const item of menuItems) {
        const entry = $('<div class="su-dropdown-item" tabindex="0" role="menuitem"></div>')
            .append($('<i class="fa-solid fa-fw"></i>').addClass(item.icon))
            .append($('<span></span>').text(item.label))
            .on('click', () => {
                menu.removeClass('open');
                $(`#${item.option}`).trigger('click');
            });
        menu.append(entry);
    }

    $('#su-header-more').on('click', (e) => {
        e.stopPropagation();
        menu.toggleClass('open');
    });
    $(document).on('click', (e) => {
        if (!$(e.target).closest('#su-header-menu').length) {
            menu.removeClass('open');
        }
    });
    $('#su-menu-toggle').on('click', () => openSidebar());
    $('#su-style-chip').on('click', () => openChatRoleStyle());
    $('#su-connection').on('click', () => openSettings('connection'));
    $('#su-header-card').on('click', async () => {
        await openAdvancedPanel('rightNavHolder');
        if (this_chid !== undefined) {
            $('#rm_button_selected_ch').trigger('click');
        }
    });
    $('#su-header-world').on('click', () => openAdvancedPanel('WI-SP-button'));
}

function buildAdvancedBar() {
    const bar = $(`
        <div id="su-advanced-bar">
            <div id="su-advanced-back" class="menu_button" tabindex="0" role="button">
                <i class="fa-solid fa-arrow-left"></i><span>${t`Back`}</span>
            </div>
            <span id="su-advanced-title"></span>
        </div>
    `);
    // Lives inside the drawer holder so it shares the drawers' stacking context.
    $('#top-settings-holder').append(bar);
    $('#su-advanced-back').on('click', () => closeAdvancedPanels());

    // Drawers can also be opened by other code (slash commands, extensions) clicking their icon.
    $('#top-settings-holder').on('click', '.drawer-toggle', function () {
        setAdvancedTitle(this);
    });
    $(document).on('click', '.drawer-opener', function () {
        const toggle = document.getElementById(String($(this).attr('data-target')))?.querySelector(':scope > .drawer-toggle');
        if (toggle) {
            setAdvancedTitle(toggle);
        }
    });
}

function buildModeSwitch() {
    const modeSwitch = $(`
        <div id="su-mode-switch" role="radiogroup" aria-label="${t`Message mode`}">
            <div class="su-mode" data-ooc="false" role="radio" tabindex="0" title="${t`Your message is part of the story`}">${t`In character`}</div>
            <div class="su-mode" data-ooc="true" role="radio" tabindex="0" title="${t`Ask or comment outside of the story`}">${t`Out of character (OOC)`}</div>
        </div>
    `);
    $('#send_form').prepend(modeSwitch);
    modeSwitch.on('click', '.su-mode', function () {
        armOoc($(this).attr('data-ooc') === 'true');
        $('#send_textarea').trigger('focus');
    });

    // ooc.js owns the armed state and the visibility of #mes_ooc; mirror both.
    const oocButton = document.getElementById('mes_ooc');
    const sync = () => {
        const armed = oocButton.classList.contains('ooc_armed');
        modeSwitch.toggleClass('displayNone', oocButton.classList.contains('displayNone'));
        modeSwitch.find('.su-mode').each(function () {
            const selected = ($(this).attr('data-ooc') === 'true') === armed;
            $(this).toggleClass('selected', selected).attr('aria-checked', String(selected));
        });
    };
    new MutationObserver(sync).observe(oocButton, { attributes: true, attributeFilter: ['class'] });
    sync();
}

async function renderRecentChats() {
    const container = $('#su-recent');
    const chats = (await getRecentChats()).slice(0, MAX_RECENT_CHATS);
    container.empty();
    $('#su-recent-section').toggleClass('displayNone', chats.length === 0);

    for (const chat of chats) {
        const group = chat.is_group ? groups.find(x => x.id === chat.group) : null;
        const avatar = group ? getGroupAvatar(group).addClass('su-avatar') : avatarImg(chat.char_thumbnail);
        const item = $('<div class="su-item su-recent-chat" tabindex="0" role="button"></div>')
            .attr('title', chat.chat_name)
            .append(avatar)
            .append($('<div class="su-item-text"></div>')
                .append($('<div class="su-item-name"></div>').text(chat.char_name))
                .append($('<div class="su-item-sub"></div>').text(chat.date_short)))
            .on('click', async () => {
                closeSidebar();
                if (chat.is_group) {
                    await openRecentGroupChat(chat.group, chat.chat_name);
                } else {
                    await openRecentCharacterChat(chat.avatar, chat.chat_name);
                }
            });
        container.append(item);
    }
}

/**
 * @returns {{ id: number, character: any }[]} Characters matching the sidebar search, favorites and recent chats first
 */
function getFilteredCharacters() {
    const query = String($('#su-search').val() ?? '').trim().toLowerCase();
    return characters
        .map((character, id) => ({ id, character }))
        .filter(({ character }) => !query || String(character.name).toLowerCase().includes(query))
        .sort((a, b) => {
            const favA = a.character.fav === true || a.character.fav === 'true';
            const favB = b.character.fav === true || b.character.fav === 'true';
            if (favA !== favB) {
                return favA ? -1 : 1;
            }
            return Number(b.character.date_last_chat || 0) - Number(a.character.date_last_chat || 0);
        });
}

function renderCharacters() {
    const container = $('#su-characters');
    container.empty();
    const list = getFilteredCharacters();

    if (list.length === 0) {
        container.append($('<div class="su-empty"></div>').text(characters.length ? t`No characters found` : t`Import a character to start`));
        return;
    }

    for (const { id, character } of list) {
        const item = $('<div class="su-item su-character" tabindex="0" role="button"></div>')
            .toggleClass('active', !selected_group && String(this_chid) === String(id))
            .append(avatarImg(getThumbnailUrl('avatar', character.avatar)))
            .append($('<div class="su-item-text"></div>').append($('<div class="su-item-name"></div>').text(character.name)))
            .on('click', async () => {
                closeSidebar();
                await selectCharacterById(id);
            });
        container.append(item);
    }
}

function renderPersona() {
    $('#su-persona').empty()
        .append(avatarImg(getThumbnailUrl('persona', user_avatar)))
        .append($('<div class="su-item-text"></div>')
            .append($('<div class="su-item-name"></div>').text(name1))
            .append($('<div class="su-item-sub"></div>').text(t`Your persona`)));
}

function renderHeader() {
    const hasCharacter = !selected_group && this_chid !== undefined && characters[this_chid];
    const group = selected_group ? groups.find(x => x.id === selected_group) : null;
    const avatar = $('#su-header-avatar').empty();

    if (group) {
        avatar.append(getGroupAvatar(group).addClass('su-avatar'));
    } else {
        avatar.append(avatarImg(hasCharacter ? getThumbnailUrl('avatar', characters[this_chid].avatar) : system_avatar));
    }

    $('#su-header-name').text(group?.name ?? name2);
    $('#su-header-card').toggleClass('displayNone', !hasCharacter);
    renderConnection();
}

function renderConnection() {
    const model = getConnectedModelLabel();
    $('#su-connection')
        .toggleClass('connected', !!model)
        .text(model ? t`Connected` : t`Not connected`)
        .attr('title', model || t`Set up a connection to an AI`);
    $('#su-header-sub').text(model);
    renderStyleChip();
}

function renderStyleChip() {
    const choice = getCurrentChatId() ? getChatRoleStyle() : null;
    const style = findRoleStyle(choice?.style ?? null);
    $('#su-style-chip')
        .toggleClass('displayNone', !getCurrentChatId())
        .empty()
        .append($('<i class="fa-solid fa-fw"></i>').addClass(style?.icon ?? 'fa-masks-theater'))
        .append($('<span></span>').text(style ? style.label() : (choice ? t`No style` : t`Choose style`)));
}

/**
 * Updates the connection and role style shown in the chat header.
 */
export function refreshChatHeader() {
    renderConnection();
}

async function openNewStoryPicker() {
    closeSidebar();
    const content = $(`
        <div class="su-picker">
            <h3>${t`Who do you want to play with?`}</h3>
            <div class="su-picker-grid"></div>
            <div class="su-picker-actions">
                <div class="menu_button su-picker-import"><i class="fa-solid fa-file-import"></i><span>${t`Import character`}</span></div>
            </div>
        </div>
    `);
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', { wide: true, allowVerticalScrolling: true });
    const grid = content.find('.su-picker-grid');

    for (const { id, character } of getFilteredCharacters()) {
        const card = $('<div class="su-picker-card" tabindex="0" role="button"></div>')
            .append(avatarImg(getThumbnailUrl('avatar', character.avatar)))
            .append($('<div class="su-picker-name"></div>').text(character.name))
            .on('click', async () => {
                await popup.completeCancelled();
                await startNewStory(id);
            });
        grid.append(card);
    }

    content.find('.su-picker-import').on('click', async () => {
        await popup.completeCancelled();
        $('#character_import_button').trigger('click');
    });

    await popup.show();
}

/**
 * Opens a character and starts a fresh chat with them, unless their current chat is still untouched.
 * @param {number} id Character index
 */
async function startNewStory(id) {
    await selectCharacterById(id);
    if (chat.some(message => message.is_user)) {
        await doNewChat();
    }
}

/**
 * Switches between the simplified and the classic interface.
 * @param {boolean} enabled
 */
export function setSimpleUiEnabled(enabled) {
    accountStorage.setItem(DISABLED_STORAGE_KEY, String(!enabled));
    location.reload();
}

/**
 * Adds a way back from the classic interface to the simplified one.
 */
function addClassicModeEscape() {
    const option = $(`
        <a id="option_simple_ui">
            <i class="fa-lg fa-solid fa-wand-magic-sparkles"></i>
            <span>${t`Simple interface`}</span>
        </a>
    `);
    option.on('click', () => setSimpleUiEnabled(true));
    $('#options .options-content').prepend(option);
}

export function initSimpleUi() {
    if (accountStorage.getItem(DISABLED_STORAGE_KEY) === 'true') {
        document.body.classList.remove('simple-ui');
        addClassicModeEscape();
        return;
    }

    document.body.classList.add('simple-ui');

    // Pinned drawers would stay open over the chat; pinning has no meaning in the overlay.
    $('.pinnedOpen').removeClass('pinnedOpen');
    $('.drawerPinnedOpen').removeClass('drawerPinnedOpen');

    // Before the header handlers below, so a new chat already has its style when the header renders.
    initRoleStyles();

    buildSidebar();
    buildChatHeader();
    buildAdvancedBar();
    buildModeSwitch();

    const refreshLists = debounce(() => {
        renderCharacters();
        void renderRecentChats();
    }, 200);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderHeader();
        refreshLists();
    });
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, refreshLists);
    eventSource.on(event_types.CHARACTER_EDITED, refreshLists);
    eventSource.on(event_types.CHARACTER_DELETED, refreshLists);
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, renderConnection);
    eventSource.on(event_types.PERSONA_CHANGED, renderPersona);
    eventSource.on(event_types.PERSONA_RENAMED, renderPersona);
    eventSource.on(event_types.SETTINGS_UPDATED, renderPersona);
    eventSource.on(event_types.SETTINGS_UPDATED, renderConnection);
    eventSource.on(event_types.APP_READY, () => {
        renderHeader();
        renderPersona();
        refreshLists();
    });

    $(document).on('keydown', (e) => {
        if (e.key !== 'Escape' || document.querySelector('dialog[open]')) {
            return;
        }
        $('#su-header-menu').removeClass('open');
        closeSidebar();
        if (document.querySelector('#top-settings-holder .drawer-content.openDrawer')) {
            void closeAdvancedPanels();
        }
    });
}
