import express from 'express';
import fetch from 'node-fetch';

export const router = express.Router();

const PROBE_TIMEOUT_MS = 1200;
const HOST = 'http://127.0.0.1';

/**
 * @typedef {object} DetectedBackend
 * @property {string} engine Engine identifier
 * @property {string} label Display name
 * @property {string} baseUrl OpenAI-compatible base URL (ending in /v1)
 * @property {string[]} models Model IDs reported by the server
 */

/**
 * Fetches JSON from a local URL, giving up quickly when nothing answers.
 * @param {string} url
 * @returns {Promise<any|null>} Parsed JSON, or null on any failure
 */
async function getJson(url) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!response.ok) {
            return null;
        }
        return await response.json();
    } catch {
        return null;
    }
}

/**
 * Extracts model IDs from an OpenAI-style model list.
 * @param {any} data Response of GET /v1/models
 * @returns {string[]|null} Model IDs, or null if the response is not a model list
 */
function getOpenAiModelIds(data) {
    if (!Array.isArray(data?.data)) {
        return null;
    }
    return data.data.map(model => String(model?.id ?? '')).filter(Boolean);
}

/**
 * Drops models that can't chat, such as embedding models.
 * @param {string[]} models
 * @returns {string[]}
 */
function filterChatModels(models) {
    return models.filter(model => !/embed/i.test(model));
}

/** @returns {Promise<DetectedBackend|null>} */
async function probeLmStudio() {
    const origin = `${HOST}:1234`;
    const models = getOpenAiModelIds(await getJson(`${origin}/v1/models`));
    if (!models) {
        return null;
    }
    // LM Studio's native API tells which model is loaded and which are embeddings; list the loaded one first.
    const native = await getJson(`${origin}/api/v0/models`);
    if (Array.isArray(native?.data)) {
        const chatModels = native.data.filter(model => model?.type !== 'embeddings');
        const loaded = chatModels.filter(model => model?.state === 'loaded');
        const others = chatModels.filter(model => model?.state !== 'loaded');
        return { engine: 'lmstudio', label: 'LM Studio', baseUrl: `${origin}/v1`, models: [...loaded, ...others].map(model => String(model.id)) };
    }
    return { engine: 'lmstudio', label: 'LM Studio', baseUrl: `${origin}/v1`, models: filterChatModels(models) };
}

/** @returns {Promise<DetectedBackend|null>} */
async function probeLlamaCpp() {
    const origin = `${HOST}:8080`;
    const models = getOpenAiModelIds(await getJson(`${origin}/v1/models`));
    if (!models) {
        return null;
    }
    // Only llama.cpp server exposes /props with its generation settings.
    const props = await getJson(`${origin}/props`);
    const isLlamaCpp = !!props?.default_generation_settings;
    return {
        engine: isLlamaCpp ? 'llamacpp' : 'openai-compatible',
        label: isLlamaCpp ? 'llama.cpp' : 'OpenAI-compatible server (:8080)',
        baseUrl: `${origin}/v1`,
        models,
    };
}

/** @returns {Promise<DetectedBackend|null>} */
async function probeKoboldCpp() {
    const origin = `${HOST}:5001`;
    // KoboldCpp answers its native API with { result: "koboldcpp/<model>" }.
    const native = await getJson(`${origin}/api/v1/model`);
    if (typeof native?.result !== 'string') {
        return null;
    }
    const models = getOpenAiModelIds(await getJson(`${origin}/v1/models`)) ?? [native.result.replace(/^koboldcpp\//, '')];
    return { engine: 'koboldcpp', label: 'KoboldCpp', baseUrl: `${origin}/v1`, models };
}

/** @returns {Promise<DetectedBackend|null>} */
async function probeOllama() {
    const origin = `${HOST}:11434`;
    const tags = await getJson(`${origin}/api/tags`);
    if (!Array.isArray(tags?.models)) {
        return null;
    }
    const models = tags.models.map(model => String(model?.name ?? model?.model ?? '')).filter(Boolean);
    return { engine: 'ollama', label: 'Ollama', baseUrl: `${origin}/v1`, models };
}

/** @returns {Promise<DetectedBackend|null>} */
async function probeTextGenerationWebUi() {
    const baseUrl = `${HOST}:5000/v1`;
    const models = getOpenAiModelIds(await getJson(`${baseUrl}/models`));
    return models ? { engine: 'ooba', label: 'text-generation-webui', baseUrl, models } : null;
}

/**
 * Probes the default ports of popular local inference engines.
 * Only fixed loopback addresses are probed, so this cannot be used to reach arbitrary hosts.
 */
router.post('/', async function (_request, response) {
    const probes = [probeLmStudio, probeLlamaCpp, probeKoboldCpp, probeOllama, probeTextGenerationWebUi];
    const results = await Promise.all(probes.map(probe => probe()));
    const backends = results.filter(Boolean).map(backend => ({ ...backend, models: filterChatModels(backend.models) }));
    return response.send({ backends });
});
