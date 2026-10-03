'use strict';

const DEFAULTS = {
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  minChars: 15,
  excludedSites: ''
};

const SYSTEM_INSTRUCTION =
  'Responde en máximo 2 frases cortas. Si el texto es una pregunta, respóndela; si no, explícalo o resúmelo. Usa el idioma del texto.';

const MAX_CHARS = 1500;
const CACHE_LIMIT = 80;

const settings = Object.assign({}, DEFAULTS);
const cache = new Map();
const inflight = new Map();

chrome.storage.local.get(DEFAULTS, (values) => {
  if (values) Object.assign(settings, values);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  Object.keys(DEFAULTS).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      settings[key] = changes[key].newValue;
      cache.clear();
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === 'select-ai:ask') {
    ask(String(message.text || '')).then(sendResponse);
    return true;
  }

  if (message.type === 'select-ai:test') {
    testConnection().then(sendResponse);
    return true;
  }

  return undefined;
});

function ask(rawText) {
  const text = rawText.slice(0, MAX_CHARS).trim();
  if (!text) return Promise.resolve({ ok: false, error: 'Sin texto seleccionado' });

  const apiKey = String(settings.apiKey || '').trim();
  if (!apiKey) {
    return Promise.resolve({ ok: false, error: 'Configura tu API key en las opciones' });
  }

  if (cache.has(text)) return Promise.resolve({ ok: true, text: cache.get(text) });
  if (inflight.has(text)) return inflight.get(text);

  const model = String(settings.model || '').trim() || DEFAULTS.model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { maxOutputTokens: 150, temperature: 0.3 }
  };

  const pending = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body)
  })
    .then(async (response) => {
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { ok: false, error: describeError(response.status, detail) };
      }
      const data = await response.json().catch(() => null);
      const answer = extractText(data);
      if (!answer) {
        return { ok: false, error: blockedReason(data) || 'La API no devolvió texto' };
      }
      cache.set(text, answer);
      trimCache();
      return { ok: true, text: answer };
    })
    .catch(() => ({ ok: false, error: 'Sin conexión con la API' }))
    .finally(() => {
      inflight.delete(text);
    });

  inflight.set(text, pending);
  return pending;
}

function testConnection() {
  const apiKey = String(settings.apiKey || '').trim();
  if (!apiKey) {
    return Promise.resolve({ ok: false, error: 'Configura tu API key en las opciones' });
  }
  return ask('Hola');
}

function extractText(data) {
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts
    : null;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}

function blockedReason(data) {
  const feedback = data && data.promptFeedback;
  if (feedback && feedback.blockReason) {
    return 'La API bloqueó la petición (' + feedback.blockReason + ')';
  }
  const candidate = data && data.candidates && data.candidates[0];
  if (candidate && candidate.finishReason && candidate.finishReason !== 'STOP') {
    return 'La API no pudo responder (' + candidate.finishReason + ')';
  }
  return '';
}

function describeError(status, detail) {
  if (status === 400 || status === 404) {
    return 'Modelo o API no válidos: revisa el nombre del modelo';
  }
  if (status === 401 || status === 403) {
    return 'API key inválida o sin permisos';
  }
  if (status === 429) {
    return 'Límite alcanzado, espera un momento';
  }
  if (status >= 500) {
    return 'La API no está disponible, inténtalo más tarde';
  }
  const extra = String(detail || '').slice(0, 60).replace(/\s+/g, ' ');
  return extra ? 'Error ' + status + ': ' + extra : 'Error ' + status;
}

function trimCache() {
  while (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
}
