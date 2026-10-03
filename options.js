'use strict';

const DEFAULTS = {
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  minChars: 15,
  excludedSites: ''
};

const form = document.getElementById('form');
const apiKeyInput = document.getElementById('apiKey');
const modelInput = document.getElementById('model');
const minCharsInput = document.getElementById('minChars');
const excludedInput = document.getElementById('excludedSites');
const toggleKeyButton = document.getElementById('toggleKey');
const testButton = document.getElementById('test');
const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');

function setStatus(message, tone) {
  statusEl.textContent = message;
  statusEl.setAttribute('data-tone', tone || '');
}

chrome.storage.local.get(DEFAULTS, (values) => {
  const settings = Object.assign({}, DEFAULTS, values);
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model;
  minCharsInput.value = settings.minChars;
  excludedInput.value = settings.excludedSites;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const minChars = parseInt(minCharsInput.value, 10);
  const payload = {
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim() || DEFAULTS.model,
    minChars: Number.isFinite(minChars) && minChars >= 0 ? minChars : DEFAULTS.minChars,
    excludedSites: excludedInput.value.trim()
  };
  chrome.storage.local.set(payload, () => {
    setStatus('Guardado', 'ok');
  });
  previewEl.hidden = true;
});

toggleKeyButton.addEventListener('click', () => {
  const hidden = apiKeyInput.type === 'password';
  apiKeyInput.type = hidden ? 'text' : 'password';
  toggleKeyButton.textContent = hidden ? 'Ocultar' : 'Ver';
});

testButton.addEventListener('click', () => {
  const minChars = parseInt(minCharsInput.value, 10);
  const payload = {
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim() || DEFAULTS.model,
    minChars: Number.isFinite(minChars) && minChars >= 0 ? minChars : DEFAULTS.minChars,
    excludedSites: excludedInput.value.trim()
  };
  testButton.disabled = true;
  setStatus('Probando…');
  previewEl.hidden = true;
  chrome.storage.local.set(payload, () => {
    chrome.runtime.sendMessage({ type: 'select-ai:test' }, (response) => {
      testButton.disabled = false;
      if (!response) {
        setStatus('Sin respuesta del servicio', 'error');
        return;
      }
      if (response.ok) {
        setStatus('Conexión correcta', 'ok');
        previewEl.textContent = 'Respuesta de prueba: ' + response.text;
        previewEl.hidden = false;
      } else {
        setStatus(response.error || 'Error desconocido', 'error');
      }
    });
  });
});
