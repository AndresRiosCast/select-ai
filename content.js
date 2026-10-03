(() => {
  'use strict';

  if (window.__selectAiInjected) return;
  window.__selectAiInjected = true;

  const HOST_ID = 'select-ai-host';
  const REQUEST_TYPE = 'select-ai:ask';
  const DEBOUNCE_MS = 700;
  const MAX_CHARS = 1500;
  const CACHE_LIMIT = 80;
  const EDGE = 10;
  const GAP = 8;

  const DEFAULTS = {
    apiKey: '',
    model: 'gemini-3.5-flash-lite',
    minChars: 15,
    excludedSites: ''
  };

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.bubble {
  position: absolute;
  display: none;
  max-width: 320px;
  min-width: 150px;
  padding: 9px 12px 10px;
  font: 400 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #1f2328;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, .10);
  border-radius: 12px;
  box-shadow: 0 6px 24px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .10);
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  opacity: 0;
  transition: opacity .12s ease;
}
.bubble.show { display: block; opacity: 1; }
.arrow {
  position: absolute;
  width: 10px;
  height: 10px;
  margin-left: -5px;
  background: inherit;
  border: inherit;
  transform: rotate(45deg);
}
.bubble[data-placement="below"] .arrow {
  top: -6px;
  border-right: 1px solid rgba(0, 0, 0, .10);
  border-top: 1px solid rgba(0, 0, 0, .10);
}
.bubble[data-placement="above"] .arrow {
  bottom: -6px;
  border-left: 1px solid rgba(0, 0, 0, .10);
  border-bottom: 1px solid rgba(0, 0, 0, .10);
}
.text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.bubble[data-tone="error"] { color: #b42318; }
.bubble[data-state="loading"] .text { color: #6b7280; animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
@media (prefers-color-scheme: dark) {
  .bubble {
    color: #e6e6e6;
    background: #22242a;
    border-color: rgba(255, 255, 255, .12);
    box-shadow: 0 6px 24px rgba(0, 0, 0, .55), 0 2px 6px rgba(0, 0, 0, .40);
  }
  .bubble[data-placement="below"] .arrow { border-right-color: rgba(255, 255, 255, .12); border-top-color: rgba(255, 255, 255, .12); }
  .bubble[data-placement="above"] .arrow { border-left-color: rgba(255, 255, 255, .12); border-bottom-color: rgba(255, 255, 255, .12); }
  .bubble[data-tone="error"] { color: #ff9f94; }
  .bubble[data-state="loading"] .text { color: #9aa0a6; }
}
@media (prefers-reduced-motion: reduce) {
  .bubble { transition: none; }
  .bubble[data-state="loading"] .text { animation: none; }
}
`;

  const settings = Object.assign({}, DEFAULTS);
  const cache = new Map();

  let host = null;
  let bubble = null;
  let arrow = null;
  let textEl = null;
  let activeKey = null;
  let activeRange = null;
  let timerId = 0;
  let frameId = 0;
  let requestSeq = 0;

  const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

  chrome.storage.local.get(DEFAULTS, (values) => {
    if (values) Object.assign(settings, values);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    Object.keys(DEFAULTS).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(changes, key)) {
        settings[key] = changes[key].newValue;
      }
    });
  });

  function minChars() {
    const parsed = parseInt(settings.minChars, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULTS.minChars;
  }

  function currentSelection() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (host && ((anchor && host.contains(anchor)) || (focus && host.contains(focus)))) return null;
    const text = selection.toString();
    if (!text.trim()) return null;
    return { selection, text };
  }

  function isEditableContext(selection) {
    const nodes = [selection.anchorNode, selection.focusNode, document.activeElement];
    for (const node of nodes) {
      if (!node) continue;
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!element || !element.tagName) continue;
      const tag = element.tagName.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (element.isContentEditable) return true;
      const attr = element.getAttribute('contenteditable');
      if (attr === '' || attr === 'true' || attr === 'plaintext-only') return true;
    }
    return false;
  }

  function isExcludedHost() {
    const raw = String(settings.excludedSites || '');
    if (!raw.trim()) return false;
    const current = window.location.hostname.toLowerCase();
    const list = raw.split(/[\s,;]+/);
    for (const entry of list) {
      let domain = entry.trim().toLowerCase();
      if (!domain) continue;
      domain = domain.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
      domain = domain.replace(/^www\./, '').replace(/^\*?\*/, '').replace(/^\.+/, '');
      if (!domain) continue;
      if (current === domain || current.endsWith('.' + domain)) return true;
    }
    return false;
  }

  function ensureBubble() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute(
      'style',
      'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;'
    );
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    bubble = document.createElement('div');
    bubble.className = 'bubble';
    arrow = document.createElement('div');
    arrow.className = 'arrow';
    textEl = document.createElement('div');
    textEl.className = 'text';
    bubble.appendChild(arrow);
    bubble.appendChild(textEl);
    shadow.appendChild(style);
    shadow.appendChild(bubble);
    (document.body || document.documentElement).appendChild(host);
  }

  function hide() {
    requestSeq += 1;
    activeKey = null;
    activeRange = null;
    if (bubble) bubble.classList.remove('show');
  }

  function setText(value, state) {
    if (!bubble) return;
    textEl.textContent = value;
    bubble.setAttribute('data-state', state);
    bubble.setAttribute('data-tone', state === 'error' ? 'error' : 'ok');
  }

  function position() {
    if (!bubble || !activeRange || !host || !host.isConnected) return;
    let rect = null;
    try {
      const rects = activeRange.getClientRects();
      for (let i = rects.length - 1; i >= 0; i -= 1) {
        if (rects[i].width > 0 || rects[i].height > 0) {
          rect = rects[i];
          break;
        }
      }
      if (!rect) rect = activeRange.getBoundingClientRect();
    } catch (error) {
      rect = null;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hide();
      return;
    }

    const viewWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewHeight = document.documentElement.clientHeight || window.innerHeight;
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;

    let top = rect.bottom + GAP;
    let placement = 'below';
    if (top + height + EDGE > viewHeight) {
      const above = rect.top - GAP - height;
      if (above >= EDGE) {
        top = above;
        placement = 'above';
      } else {
        top = Math.max(EDGE, viewHeight - height - EDGE);
      }
    }

    let left = rect.left;
    left = Math.min(left, viewWidth - width - EDGE);
    left = Math.max(EDGE, left);

    bubble.style.top = Math.round(top + window.scrollY) + 'px';
    bubble.style.left = Math.round(left + window.scrollX) + 'px';
    bubble.setAttribute('data-placement', placement);

    const center = rect.left + rect.width / 2 - left;
    arrow.style.left = Math.round(Math.min(Math.max(center, 14), Math.max(width - 14, 14))) + 'px';
  }

  function onViewportChange() {
    if (frameId) return;
    frameId = window.requestAnimationFrame(() => {
      frameId = 0;
      if (activeKey) position();
    });
  }

  function schedule(key) {
    window.clearTimeout(timerId);
    timerId = window.setTimeout(() => evaluate(key), DEBOUNCE_MS);
  }

  function evaluate(expectedKey) {
    const current = currentSelection();
    if (!current) {
      hide();
      return;
    }
    const key = norm(current.text);
    if (expectedKey && key !== norm(expectedKey)) {
      schedule(key);
      return;
    }
    if (isExcludedHost()) return;
    if (isEditableContext(current.selection)) return;

    let text = current.text.trim();
    if (text.length < minChars()) return;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
    const nextKey = norm(text);
    if (!nextKey || nextKey === activeKey) return;

    activeKey = nextKey;
    activeRange = current.selection.getRangeAt(0).cloneRange();
    ensureBubble();
    bubble.classList.add('show');

    if (cache.has(nextKey)) {
      setText(cache.get(nextKey), 'done');
      position();
      return;
    }

    setText('…', 'loading');
    position();
    ask(text, nextKey);
  }

  async function ask(text, key) {
    const seq = (requestSeq += 1);
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({ type: REQUEST_TYPE, text });
    } catch (error) {
      response = null;
    }
    if (seq !== requestSeq || activeKey !== key) return;
    if (!response) {
      setText('Sin conexión con la extensión', 'error');
    } else if (response.ok) {
      const answer = String(response.text || '').trim();
      if (!answer) {
        setText('La API no devolvió texto', 'error');
      } else {
        cache.set(key, answer);
        trimCache();
        setText(answer, 'done');
      }
    } else {
      setText(String(response.error || 'Error desconocido'), 'error');
    }
    position();
  }

  function trimCache() {
    while (cache.size > CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
  }

  function isOwnEvent(event) {
    if (!host) return false;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.indexOf(host) !== -1;
  }

  document.addEventListener(
    'mouseup',
    (event) => {
      if (isOwnEvent(event)) return;
      const current = currentSelection();
      if (current) schedule(norm(current.text));
      else hide();
    },
    true
  );

  document.addEventListener(
    'mousedown',
    (event) => {
      if (isOwnEvent(event)) return;
      hide();
    },
    true
  );

  document.addEventListener('selectionchange', () => {
    const current = currentSelection();
    if (!current) {
      hide();
      window.clearTimeout(timerId);
      return;
    }
    const key = norm(current.text);
    if (activeKey && key !== activeKey) hide();
    schedule(key);
  });

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        window.clearTimeout(timerId);
        hide();
      }
    },
    true
  );

  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange, { passive: true });
})();
