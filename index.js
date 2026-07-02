// == TavernHelper Script ==
// name: 去除双思维链
// author: Codex
// version: v0.0.3
// description: 在正文 content 闭合后检测到新的 <thinking> 时自动停止当前输出，并记录触发日志。

(function () {
  'use strict';

  const SCRIPT_NAME = '去除双思维链';
  const SCRIPT_VERSION = 'v0.0.3';
  const BUTTON_NAME = '去双思维链';
  const GLOBAL_INSTANCE_KEY = '__th_remove_double_thinking_chain_instance_v1__';
  const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const STORAGE_KEY = 'th_remove_double_thinking_chain_settings_v1';
  const LOG_KEY = 'th_remove_double_thinking_chain_logs_v1';
  const STYLE_ID = 'th-remove-double-thinking-chain-style-v1';
  const WIDGET_ID = 'th-remove-double-thinking-chain-widget';
  const FLOATING_BUTTON_ID = 'th-remove-double-thinking-chain-floating-button';
  const PANEL_ID = 'th-remove-double-thinking-chain-panel';
  const MAX_LOGS = 80;

  const DEFAULT_SETTINGS = {
    enabled: true,
    autoTruncate: false,
    autoContinue: false,
    stopDelaySeconds: 30,
    continueDelaySeconds: 30,
  };

  let floatingButtonPosition = null;
  let bodyRepairObserver = null;
  let bodyRepairTimer = null;
  let floatingGuardTimers = [];
  let outputObserver = null;
  let outputPollTimer = null;
  let outputBindTimer = null;
  let bootRetryTimer = null;
  let actionTimers = [];
  let stoppingInstance = false;

  const runtime = {
    states: new Map(),
    lastStatus: '',
    lastStatusType: 'muted',
    weakIds: new WeakMap(),
    nextWeakId: 1,
    observedTarget: null,
    checking: false,
    activeTasks: new Map(),
  };

  function getHostWindow() {
    try {
      if (window.top && window.top.document) return window.top;
    } catch (error) {
      // The top document can be cross-origin in some frames.
    }
    return window;
  }

  function getHostDocument() {
    const host = getHostWindow();
    return host.document || document;
  }

  function getOwnerFrameName() {
    try {
      return String(window && window.name || '').trim();
    } catch (error) {
      return '';
    }
  }

  function clearTimers() {
    floatingGuardTimers.forEach((timer) => clearTimeout(timer));
    floatingGuardTimers = [];
    if (bodyRepairTimer) {
      clearTimeout(bodyRepairTimer);
      bodyRepairTimer = null;
    }
    if (outputPollTimer) {
      clearInterval(outputPollTimer);
      outputPollTimer = null;
    }
    if (outputBindTimer) {
      clearTimeout(outputBindTimer);
      outputBindTimer = null;
    }
    if (bootRetryTimer) {
      clearTimeout(bootRetryTimer);
      bootRetryTimer = null;
    }
    actionTimers.forEach((timer) => clearTimeout(timer));
    actionTimers = [];
    runtime.activeTasks.clear();
  }

  function disconnectObservers() {
    if (bodyRepairObserver) {
      bodyRepairObserver.disconnect();
      bodyRepairObserver = null;
    }
    if (outputObserver) {
      outputObserver.disconnect();
      outputObserver = null;
      runtime.observedTarget = null;
    }
  }

  function removeOwnedDom() {
    const doc = getHostDocument();
    [WIDGET_ID, STYLE_ID].forEach((id) => {
      const node = doc.getElementById(id);
      if (node) node.remove();
    });
    if (doc.body) {
      if (doc.body.dataset.thRemoveDoubleThinkingGuardVersion === SCRIPT_VERSION) {
        delete doc.body.dataset.thRemoveDoubleThinkingGuardVersion;
      }
    }
  }

  function stopInstance() {
    if (stoppingInstance) return;
    stoppingInstance = true;
    clearTimers();
    disconnectObservers();
    removeOwnedDom();
    const host = getHostWindow();
    if (host[GLOBAL_INSTANCE_KEY] && host[GLOBAL_INSTANCE_KEY].instanceId === INSTANCE_ID) {
      delete host[GLOBAL_INSTANCE_KEY];
    }
  }

  function claimGlobalInstance() {
    const host = getHostWindow();
    const previous = host[GLOBAL_INSTANCE_KEY];
    if (previous && previous.instanceId !== INSTANCE_ID && typeof previous.stop === 'function') {
      try {
        previous.stop();
      } catch (error) {
        console.warn(`[${SCRIPT_NAME}] 清理旧实例失败`, error);
      }
    }
    host[GLOBAL_INSTANCE_KEY] = {
      instanceId: INSTANCE_ID,
      version: SCRIPT_VERSION,
      ownerFrameName: getOwnerFrameName(),
      stop: stopInstance,
    };
  }

  function getTavernContext() {
    const host = getHostWindow();
    try {
      if (host.SillyTavern && typeof host.SillyTavern.getContext === 'function') {
        return host.SillyTavern.getContext();
      }
    } catch (error) {
      // Some builds expose SillyTavern lazily.
    }
    try {
      if (typeof host.getContext === 'function') return host.getContext();
    } catch (error) {
      // Continue with DOM fallbacks.
    }
    return null;
  }

  function notify(type, message) {
    const host = getHostWindow();
    let toastr = null;
    try {
      toastr = host.toastr || window.toastr;
    } catch (error) {
      toastr = window.toastr || null;
    }
    if (toastr && typeof toastr[type] === 'function') {
      toastr[type](message);
      return;
    }
    if (type === 'error') console.error(`[${SCRIPT_NAME}] ${message}`);
    else if (type === 'warning') console.warn(`[${SCRIPT_NAME}] ${message}`);
    else console.log(`[${SCRIPT_NAME}] ${message}`);
  }

  function getLoaderInfo() {
    const host = getHostWindow();
    return host.__TH_REMOVE_DOUBLE_THINKING_CHAIN_LOADER__ || window.__TH_REMOVE_DOUBLE_THINKING_CHAIN_LOADER__ || null;
  }

  function getVersionLabel() {
    const loader = getLoaderInfo();
    if (!loader) return SCRIPT_VERSION;
    const sourceMap = {
      latest: 'GitHub最新',
      fallback: '固定回退',
      pinned: '固定版本',
      manual: '手动版本',
    };
    const source = sourceMap[loader.source] || 'GitHub入口';
    const tag = loader.loadedTag || loader.tag || SCRIPT_VERSION;
    return `${tag} · ${source}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function decodeHtmlEntities(value) {
    const doc = getHostDocument();
    const textarea = doc.createElement('textarea');
    textarea.innerHTML = String(value || '');
    return textarea.value;
  }

  function normalizeDelaySeconds(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(300, Math.max(0, Math.round(number)));
  }

  function normalizeSettings(settings) {
    const merged = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    return {
      enabled: merged.enabled !== false,
      autoTruncate: merged.autoTruncate === true,
      autoContinue: merged.autoContinue === true,
      stopDelaySeconds: normalizeDelaySeconds(merged.stopDelaySeconds, DEFAULT_SETTINGS.stopDelaySeconds),
      continueDelaySeconds: normalizeDelaySeconds(merged.continueDelaySeconds, DEFAULT_SETTINGS.continueDelaySeconds),
    };
  }

  function loadSettings() {
    try {
      return normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch (error) {
      return normalizeSettings(DEFAULT_SETTINGS);
    }
  }

  function saveSettings(settings) {
    const next = normalizeSettings(Object.assign({}, loadSettings(), settings || {}));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function loadLogs() {
    try {
      const logs = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      return Array.isArray(logs) ? logs : [];
    } catch (error) {
      return [];
    }
  }

  function saveLogs(logs) {
    localStorage.setItem(LOG_KEY, JSON.stringify((logs || []).slice(0, MAX_LOGS)));
  }

  function addLog(entry) {
    const logs = loadLogs();
    const nextEntry = Object.assign({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toISOString(),
    }, entry || {});
    logs.unshift(nextEntry);
    saveLogs(logs);
    renderPanel();
    return nextEntry.id;
  }

  function updateLog(id, patch) {
    if (!id) return;
    const logs = loadLogs();
    const index = logs.findIndex((log) => log && log.id === id);
    if (index < 0) return;
    logs[index] = Object.assign({}, logs[index], patch || {});
    saveLogs(logs);
    renderPanel();
  }

  function clearLogs() {
    saveLogs([]);
    renderPanel();
  }

  function formatTime(value) {
    if (!value) return '';
    try {
      return new Date(value).toLocaleString('zh-CN', {
        hour12: false,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (error) {
      return String(value);
    }
  }

  function setGuardStatus(text, type = 'muted') {
    runtime.lastStatus = text || '';
    runtime.lastStatusType = type;
    const doc = getHostDocument();
    const status = doc.querySelector(`#${PANEL_ID} [data-guard-status]`);
    if (status) {
      status.textContent = runtime.lastStatus;
      status.dataset.type = runtime.lastStatusType;
    }
  }

  function injectStyle() {
    const doc = getHostDocument();
    let style = doc.getElementById(STYLE_ID);
    if (!style) {
      style = doc.createElement('style');
      style.id = STYLE_ID;
      doc.head.appendChild(style);
    }
    style.textContent = `
      #${WIDGET_ID} {
        position: fixed;
        inset: auto 0 0 auto;
        z-index: 2147483645;
        pointer-events: none;
        font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
      }
      #${WIDGET_ID} * {
        box-sizing: border-box;
      }
      #${FLOATING_BUTTON_ID},
      #${PANEL_ID} {
        pointer-events: auto;
      }
      #${FLOATING_BUTTON_ID} {
        position: fixed;
        right: 16px;
        bottom: calc(env(safe-area-inset-bottom, 0px) + 164px);
        z-index: 2147483647;
        width: 52px;
        height: 52px;
        padding: 0;
        border: 1px solid rgba(130, 190, 170, 0.9);
        border-radius: 15px;
        background: #1f6ed4;
        color: #ffffff;
        box-shadow: 0 10px 26px rgba(0, 0, 0, 0.34);
        font-size: 22px;
        line-height: 50px;
        text-align: center;
        font-weight: 900;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      #${FLOATING_BUTTON_ID}[data-enabled="false"] {
        border-color: rgba(150, 158, 168, 0.72);
        background: #626b78;
      }
      #${FLOATING_BUTTON_ID}::after {
        content: "";
        position: absolute;
        right: 6px;
        top: 6px;
        width: 10px;
        height: 10px;
        border: 2px solid rgba(255, 255, 255, 0.88);
        border-radius: 999px;
        background: #55d98b;
      }
      #${FLOATING_BUTTON_ID}[data-enabled="false"]::after {
        background: #ffb45c;
      }
      #${PANEL_ID} {
        position: fixed;
        right: 16px;
        bottom: calc(env(safe-area-inset-bottom, 0px) + 224px);
        z-index: 2147483646;
        width: min(380px, calc(100vw - 24px));
        max-height: min(640px, calc(100vh - 88px));
        display: none;
        overflow: hidden;
        border: 1px solid rgba(130, 150, 165, 0.32);
        border-radius: 12px;
        background: #151b22;
        color: #eef3ef;
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
      }
      #${PANEL_ID}[data-open="true"] {
        display: flex;
        flex-direction: column;
      }
      .th-rdt-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 14px;
        border-bottom: 1px solid rgba(130, 150, 165, 0.2);
        background: #111820;
      }
      .th-rdt-title {
        font-size: 15px;
        font-weight: 800;
      }
      .th-rdt-version {
        display: inline-block;
        margin-left: 6px;
        color: #aeb9b3;
        font-size: 11px;
        font-weight: 700;
      }
      .th-rdt-subtitle {
        margin-top: 4px;
        color: #aeb9b3;
        font-size: 12px;
        line-height: 1.45;
      }
      .th-rdt-close {
        width: 34px;
        height: 34px;
        min-width: 34px;
        border: 1px solid rgba(130, 150, 165, 0.28);
        border-radius: 9px;
        background: #1e2833;
        color: #eef3ef;
        font-size: 22px;
        line-height: 30px;
        cursor: pointer;
      }
      .th-rdt-body {
        display: grid;
        gap: 12px;
        min-height: 0;
        overflow: auto;
        padding: 14px;
        -webkit-overflow-scrolling: touch;
      }
      .th-rdt-card {
        border: 1px solid rgba(130, 150, 165, 0.22);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.045);
        padding: 12px;
      }
      .th-rdt-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .th-rdt-switch {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        cursor: pointer;
        font-weight: 800;
      }
      .th-rdt-switch input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
      }
      .th-rdt-switch-track {
        position: relative;
        width: 48px;
        height: 28px;
        border: 1px solid rgba(130, 150, 165, 0.32);
        border-radius: 999px;
        background: #626b78;
      }
      .th-rdt-switch-track::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 20px;
        height: 20px;
        border-radius: 999px;
        background: #ffffff;
        transition: transform 0.16s ease;
      }
      .th-rdt-switch input:checked + .th-rdt-switch-track {
        background: #2f7ed8;
        border-color: #77c0a6;
      }
      .th-rdt-switch input:checked + .th-rdt-switch-track::after {
        transform: translateX(20px);
      }
      .th-rdt-hint {
        margin-top: 8px;
        color: #aeb9b3;
        font-size: 12px;
        line-height: 1.5;
      }
      .th-rdt-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 10px;
        margin-top: 10px;
      }
      .th-rdt-field {
        display: grid;
        gap: 5px;
        color: #aeb9b3;
        font-size: 12px;
        font-weight: 700;
      }
      .th-rdt-input {
        width: 100%;
        min-height: 34px;
        border: 1px solid rgba(130, 150, 165, 0.32);
        border-radius: 8px;
        background: #0f151c;
        color: #eef3ef;
        padding: 6px 8px;
        font: inherit;
      }
      .th-rdt-status {
        margin-top: 8px;
        padding: 8px 10px;
        border-radius: 8px;
        background: rgba(119, 192, 166, 0.1);
        color: #bdebd9;
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .th-rdt-status[data-type="warning"] {
        background: rgba(244, 196, 95, 0.13);
        color: #ffe3a3;
      }
      .th-rdt-status[data-type="error"] {
        background: rgba(196, 112, 112, 0.14);
        color: #ffd2d2;
      }
      .th-rdt-status[data-type="muted"] {
        background: rgba(255, 255, 255, 0.055);
        color: #aeb9b3;
      }
      .th-rdt-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      .th-rdt-section-title {
        font-size: 13px;
        font-weight: 800;
      }
      .th-rdt-btn {
        min-height: 30px;
        border: 1px solid rgba(130, 150, 165, 0.28);
        border-radius: 8px;
        background: #22303c;
        color: #eef3ef;
        padding: 5px 10px;
        font-size: 12px;
        font-weight: 800;
        cursor: pointer;
      }
      .th-rdt-btn.danger {
        border-color: rgba(196, 112, 112, 0.45);
        color: #ffd2d2;
      }
      .th-rdt-log-list {
        display: grid;
        gap: 8px;
        max-height: 280px;
        overflow: auto;
        padding-right: 2px;
        -webkit-overflow-scrolling: touch;
      }
      .th-rdt-log {
        display: grid;
        gap: 4px;
        border: 1px solid rgba(130, 150, 165, 0.18);
        border-radius: 8px;
        background: rgba(16, 22, 29, 0.68);
        padding: 9px;
        font-size: 12px;
        line-height: 1.45;
      }
      .th-rdt-log-main {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .th-rdt-log-floor {
        color: #eef3ef;
        font-weight: 800;
      }
      .th-rdt-log-time,
      .th-rdt-log-method {
        color: #aeb9b3;
      }
      .th-rdt-log-snippet {
        color: #bdebd9;
        overflow-wrap: anywhere;
      }
      .th-rdt-empty {
        padding: 18px 8px;
        color: #aeb9b3;
        text-align: center;
        font-size: 12px;
      }
      @media (max-width: 820px) {
        #${FLOATING_BUTTON_ID} {
          top: calc(env(safe-area-inset-top, 0px) + 18px);
          right: 14px;
          bottom: auto;
          width: 56px;
          height: 56px;
          border-radius: 16px;
          line-height: 54px;
          font-size: 23px;
        }
        #${PANEL_ID} {
          inset: 0;
          width: 100vw;
          max-width: 100vw;
          height: 100vh;
          max-height: 100vh;
          border-radius: 0;
          border-left: 0;
          border-right: 0;
          border-top: 0;
          border-bottom: 0;
        }
        @supports (height: 100dvh) {
          #${PANEL_ID} {
            height: 100dvh;
            max-height: 100dvh;
          }
        }
        .th-rdt-head {
          padding: calc(env(safe-area-inset-top, 0px) + 10px) 12px 10px;
        }
        .th-rdt-body {
          padding: 12px 12px calc(env(safe-area-inset-bottom, 0px) + 88px);
        }
        .th-rdt-close {
          width: 44px;
          height: 44px;
          min-width: 44px;
          min-height: 44px;
          font-size: 28px;
          line-height: 40px;
        }
        .th-rdt-btn {
          min-height: 38px;
        }
        .th-rdt-grid {
          grid-template-columns: minmax(0, 1fr);
        }
        .th-rdt-input {
          min-height: 40px;
        }
        .th-rdt-log-list {
          max-height: none;
        }
      }
    `;
  }

  function ensureWidgetContainer() {
    const doc = getHostDocument();
    let widget = doc.getElementById(WIDGET_ID);
    if (widget && widget.dataset.thRemoveDoubleThinkingVersion !== SCRIPT_VERSION) {
      widget.remove();
      widget = null;
    }
    if (!widget) {
      widget = doc.createElement('div');
      widget.id = WIDGET_ID;
      doc.body.appendChild(widget);
    }
    widget.dataset.thRemoveDoubleThinkingVersion = SCRIPT_VERSION;
    widget.dataset.thRemoveDoubleThinkingInstance = INSTANCE_ID;
    return widget;
  }

  function getViewportSize() {
    const host = getHostWindow();
    const doc = getHostDocument();
    const visual = host.visualViewport;
    return {
      width: visual && visual.width || host.innerWidth || doc.documentElement.clientWidth || 800,
      height: visual && visual.height || host.innerHeight || doc.documentElement.clientHeight || 600,
    };
  }

  function applyFloatingButtonPosition(button) {
    if (!button || !floatingButtonPosition) return;
    button.style.left = `${floatingButtonPosition.left}px`;
    button.style.top = `${floatingButtonPosition.top}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
  }

  function ensureFloatingButtonInViewport(button) {
    if (!button || button.style.display === 'none' || !button.isConnected) return;
    const viewport = getViewportSize();
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const outside = rect.right < 8 || rect.bottom < 8 || rect.left > viewport.width - 8 || rect.top > viewport.height - 8;
    if (!outside) return;
    floatingButtonPosition = null;
    button.style.left = '';
    button.style.top = '';
    button.style.right = '';
    button.style.bottom = '';
  }

  function bindFloatingButtonDrag(button) {
    if (!button || button.dataset.thRemoveDoubleThinkingDragBound === 'true') return;
    button.dataset.thRemoveDoubleThinkingDragBound = 'true';
    let active = false;
    let pointerId = null;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let suppressClickUntil = 0;

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const begin = (clientX, clientY, id) => {
      const rect = button.getBoundingClientRect();
      active = true;
      pointerId = id == null ? null : id;
      moved = false;
      startX = clientX;
      startY = clientY;
      startLeft = rect.left;
      startTop = rect.top;
      button.style.left = `${rect.left}px`;
      button.style.top = `${rect.top}px`;
      button.style.right = 'auto';
      button.style.bottom = 'auto';
      button.style.cursor = 'grabbing';
    };
    const move = (clientX, clientY) => {
      if (!active) return;
      const dx = clientX - startX;
      const dy = clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      const viewport = getViewportSize();
      const left = clamp(startLeft + dx, 8, Math.max(8, viewport.width - button.offsetWidth - 8));
      const top = clamp(startTop + dy, 8, Math.max(8, viewport.height - button.offsetHeight - 8));
      button.style.left = `${left}px`;
      button.style.top = `${top}px`;
      floatingButtonPosition = { left, top };
    };
    const finish = (event) => {
      if (!active) return;
      active = false;
      pointerId = null;
      button.style.cursor = 'grab';
      suppressClickUntil = Date.now() + 420;
      if (moved) {
        if (event && event.cancelable) event.preventDefault();
        return;
      }
      togglePanel();
    };

    const doc = getHostDocument();
    if (getHostWindow().PointerEvent) {
      button.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        begin(event.clientX, event.clientY, event.pointerId);
        if (event.cancelable) event.preventDefault();
        try {
          button.setPointerCapture(event.pointerId);
        } catch (error) {
          // Pointer capture is optional here.
        }
      });
      doc.addEventListener('pointermove', (event) => {
        if (!active || (pointerId !== null && event.pointerId !== pointerId)) return;
        move(event.clientX, event.clientY);
        if (event.cancelable) event.preventDefault();
      }, { passive: false });
      doc.addEventListener('pointerup', (event) => {
        if (!active || (pointerId !== null && event.pointerId !== pointerId)) return;
        finish(event);
      }, { passive: false });
      doc.addEventListener('pointercancel', () => {
        active = false;
        pointerId = null;
        button.style.cursor = 'grab';
      }, { passive: true });
    } else {
      button.addEventListener('touchstart', (event) => {
        const touch = event.changedTouches && event.changedTouches[0];
        if (!touch) return;
        begin(touch.clientX, touch.clientY, touch.identifier);
        if (event.cancelable) event.preventDefault();
      }, { passive: false });
      doc.addEventListener('touchmove', (event) => {
        if (!active) return;
        const touches = Array.from(event.changedTouches || []);
        const touch = touches.find((item) => item.identifier === pointerId) || touches[0];
        if (!touch) return;
        move(touch.clientX, touch.clientY);
        if (event.cancelable) event.preventDefault();
      }, { passive: false });
      doc.addEventListener('touchend', (event) => {
        if (!active) return;
        finish(event);
      }, { passive: false });
      doc.addEventListener('touchcancel', () => {
        active = false;
        pointerId = null;
        button.style.cursor = 'grab';
      }, { passive: true });
    }

    button.addEventListener('click', (event) => {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }

  function syncFloatingButtonState(button) {
    if (!button) return;
    const settings = loadSettings();
    const enabledValue = settings.enabled ? 'true' : 'false';
    const title = settings.enabled ? '去除双思维链：守护开启' : '去除双思维链：守护关闭';
    if (button.dataset.enabled !== enabledValue) button.dataset.enabled = enabledValue;
    if (button.textContent !== '🧠') button.textContent = '🧠';
    if (button.title !== title) button.title = title;
    if (button.getAttribute('aria-label') !== title) button.setAttribute('aria-label', title);
  }

  function ensureFloatingButton() {
    const doc = getHostDocument();
    const widget = ensureWidgetContainer();
    let button = doc.getElementById(FLOATING_BUTTON_ID);
    if (button && button.dataset.thRemoveDoubleThinkingVersion !== SCRIPT_VERSION) {
      const rect = button.getBoundingClientRect();
      if (rect.width && rect.height) floatingButtonPosition = { left: rect.left, top: rect.top };
      button.remove();
      button = null;
    }
    if (!button) {
      button = doc.createElement('button');
      button.id = FLOATING_BUTTON_ID;
      button.type = 'button';
      button.dataset.thRemoveDoubleThinkingVersion = SCRIPT_VERSION;
      widget.appendChild(button);
    }
    if (button.parentNode !== widget) widget.appendChild(button);
    syncFloatingButtonState(button);
    applyFloatingButtonPosition(button);
    bindFloatingButtonDrag(button);
    ensureFloatingButtonInViewport(button);
    return button;
  }

  function buildLogHtml() {
    const logs = loadLogs();
    if (!logs.length) {
      return '<div class="th-rdt-empty">还没有触发记录。守护开启后，只会在 &lt;/content&gt; 之后出现新的 &lt;thinking&gt; 时停止。</div>';
    }
    return logs.map((log) => `
      <div class="th-rdt-log">
        <div class="th-rdt-log-main">
          <span class="th-rdt-log-floor">${escapeHtml(log.floorLabel || '未知楼层')}</span>
          <span class="th-rdt-log-time">${escapeHtml(formatTime(log.time))}</span>
        </div>
        <div class="th-rdt-log-snippet">前 10 字：${escapeHtml(log.snippet || '（空）')}</div>
        <div class="th-rdt-log-method">停止方式：${escapeHtml(log.stopMethod || log.stopError || '已尝试停止')}</div>
        <div class="th-rdt-log-method">截断：${escapeHtml(log.truncateMethod || log.truncateError || log.truncateStatus || '未执行')}</div>
        <div class="th-rdt-log-method">续写：${escapeHtml(log.continueMethod || log.continueError || log.continueStatus || '未执行')}</div>
      </div>
    `).join('');
  }

  function buildPanelHtml() {
    const settings = loadSettings();
    const versionLabel = getVersionLabel();
    const status = runtime.lastStatus || (settings.enabled ? '守护已开启，等待正在生成的回复。' : '守护已关闭，浮窗仍会常驻。');
    const statusType = runtime.lastStatusType || 'muted';
    return `
      <div class="th-rdt-head">
        <div>
          <div class="th-rdt-title">去除双思维链 <span class="th-rdt-version">${escapeHtml(versionLabel)}</span></div>
          <div class="th-rdt-subtitle">检测规则：只在正文 &lt;/content&gt; 之后发现新的 &lt;thinking&gt; 时停止当前输出。</div>
        </div>
        <button type="button" class="th-rdt-close" data-action="close-panel" title="关闭面板" aria-label="关闭面板">×</button>
      </div>
      <div class="th-rdt-body">
        <section class="th-rdt-card">
          <div class="th-rdt-row">
            <label class="th-rdt-switch">
              <input type="checkbox" data-field="enabled"${settings.enabled ? ' checked' : ''}>
              <span class="th-rdt-switch-track" aria-hidden="true"></span>
              <span>${settings.enabled ? '守护已开启' : '守护已关闭'}</span>
            </label>
          </div>
          <div class="th-rdt-hint">关闭守护只会暂停自动停止；浮窗会继续常驻，除非在酒馆助手里停用脚本。</div>
          <div class="th-rdt-status" data-guard-status data-type="${escapeHtml(statusType)}">${escapeHtml(status)}</div>
        </section>
        <section class="th-rdt-card">
          <div class="th-rdt-section-title">谨慎自动处理</div>
          <div class="th-rdt-hint">默认只停止。开启后会按顺序：停止 → 等待 → 删除第二个 &lt;thinking&gt; 起的内容 → 等待 → 续写。</div>
          <div class="th-rdt-row" style="margin-top:10px;">
            <label class="th-rdt-switch">
              <input type="checkbox" data-field="autoTruncate"${settings.autoTruncate ? ' checked' : ''}>
              <span class="th-rdt-switch-track" aria-hidden="true"></span>
              <span>${settings.autoTruncate ? '自动截断已开启' : '自动截断已关闭'}</span>
            </label>
          </div>
          <div class="th-rdt-row" style="margin-top:10px;">
            <label class="th-rdt-switch">
              <input type="checkbox" data-field="autoContinue"${settings.autoContinue ? ' checked' : ''}>
              <span class="th-rdt-switch-track" aria-hidden="true"></span>
              <span>${settings.autoContinue ? '截断后自动续写已开启' : '截断后自动续写已关闭'}</span>
            </label>
          </div>
          <div class="th-rdt-grid">
            <label class="th-rdt-field">
              <span>停止后等待秒数</span>
              <input class="th-rdt-input" type="number" min="0" max="300" step="1" data-field="stopDelaySeconds" value="${escapeHtml(settings.stopDelaySeconds)}">
            </label>
            <label class="th-rdt-field">
              <span>删除后等待秒数</span>
              <input class="th-rdt-input" type="number" min="0" max="300" step="1" data-field="continueDelaySeconds" value="${escapeHtml(settings.continueDelaySeconds)}">
            </label>
          </div>
        </section>
        <section class="th-rdt-card">
          <div class="th-rdt-section-head">
            <div class="th-rdt-section-title">停止日志</div>
            <button type="button" class="th-rdt-btn danger" data-action="clear-logs">清空日志</button>
          </div>
          <div class="th-rdt-log-list">
            ${buildLogHtml()}
          </div>
        </section>
      </div>
    `;
  }

  function bindPanel(panel) {
    if (!panel || panel.dataset.thRemoveDoubleThinkingPanelBound === 'true') return;
    panel.dataset.thRemoveDoubleThinkingPanelBound = 'true';
    panel.addEventListener('click', (event) => {
      const actionNode = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
      if (!actionNode || !panel.contains(actionNode)) return;
      const action = actionNode.dataset.action;
      if (action === 'close-panel') {
        closePanel();
      } else if (action === 'clear-logs') {
        if (confirm('确定清空停止日志吗？')) clearLogs();
      }
    });
    panel.addEventListener('change', (event) => {
      const field = event.target && event.target.dataset ? event.target.dataset.field : '';
      if (!field) return;
      const patch = {};
      if (['enabled', 'autoTruncate', 'autoContinue'].includes(field)) {
        patch[field] = Boolean(event.target.checked);
      } else if (['stopDelaySeconds', 'continueDelaySeconds'].includes(field)) {
        patch[field] = normalizeDelaySeconds(event.target.value, DEFAULT_SETTINGS[field]);
      } else {
        return;
      }
      const settings = saveSettings(patch);
      syncFloatingButtonState(getHostDocument().getElementById(FLOATING_BUTTON_ID));
      if (field === 'enabled') {
        runtime.states.clear();
        primeCurrentMessageBaseline();
      }
      setGuardStatus(settings.enabled ? '设置已保存，守护正在按当前配置工作。' : '守护已关闭，浮窗仍会常驻。', settings.enabled ? 'muted' : 'warning');
      renderPanel();
    });
  }

  function ensurePanel() {
    const doc = getHostDocument();
    const widget = ensureWidgetContainer();
    let panel = doc.getElementById(PANEL_ID);
    if (panel && panel.dataset.thRemoveDoubleThinkingVersion !== SCRIPT_VERSION) {
      panel.remove();
      panel = null;
    }
    if (!panel) {
      panel = doc.createElement('div');
      panel.id = PANEL_ID;
      panel.dataset.thRemoveDoubleThinkingVersion = SCRIPT_VERSION;
      panel.dataset.open = 'false';
      widget.appendChild(panel);
      bindPanel(panel);
    }
    if (panel.parentNode !== widget) widget.appendChild(panel);
    return panel;
  }

  function renderPanel() {
    const panel = getHostDocument().getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = buildPanelHtml();
    bindPanel(panel);
  }

  function openPanel() {
    injectStyle();
    ensureFloatingButton();
    const panel = ensurePanel();
    panel.innerHTML = buildPanelHtml();
    bindPanel(panel);
    panel.dataset.open = 'true';
  }

  function closePanel() {
    const panel = getHostDocument().getElementById(PANEL_ID);
    if (panel) panel.dataset.open = 'false';
  }

  function togglePanel() {
    const panel = ensurePanel();
    if (panel.dataset.open === 'true') closePanel();
    else openPanel();
  }

  function isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getHostWindow().getComputedStyle ? getHostWindow().getComputedStyle(element) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findStopControl() {
    const doc = getHostDocument();
    const selectors = [
      '#mes_stop',
      '#send_but_stop',
      '#stop_generating',
      '#generation_stop',
      '[data-action="stop-generation"]',
      'button[title*="Stop generation"]',
      'button[title*="停止生成"]',
      'button[aria-label*="Stop generation"]',
      'button[aria-label*="停止生成"]',
    ];
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      if (node && isElementVisible(node) && !node.disabled) return node;
    }
    const candidates = Array.from(doc.querySelectorAll('button, .menu_button, [role="button"]'));
    return candidates.find((node) => {
      if (!isElementVisible(node) || node.disabled) return false;
      const label = [
        node.id,
        node.className,
        node.getAttribute('title'),
        node.getAttribute('aria-label'),
        node.getAttribute('data-i18n'),
        node.textContent,
      ].join(' ').toLowerCase();
      const looksStop = label.includes('stop generation') || label.includes('abort') || label.includes('cancel generation') || label.includes('停止生成') || label.includes('中止生成');
      const looksSend = label.includes('send') || label.includes('发送');
      return looksStop && !looksSend;
    }) || null;
  }

  function isGenerationActive() {
    const host = getHostWindow();
    const context = getTavernContext();
    const flagCandidates = [
      host.is_send_press,
      host.generation_started,
      host.is_generation_started,
      host.isGenerating,
      context && context.is_send_press,
      context && context.generation_started,
      context && context.is_generation_started,
      context && context.isGenerating,
    ];
    if (flagCandidates.some((value) => value === true)) return true;
    if (findStopControl()) return true;
    return null;
  }

  function clickStopControl(control) {
    const host = getHostWindow();
    try {
      control.dispatchEvent(new host.MouseEvent('mousedown', { bubbles: true, cancelable: true, view: host }));
      control.dispatchEvent(new host.MouseEvent('mouseup', { bubbles: true, cancelable: true, view: host }));
    } catch (error) {
      // Some embedded browsers reject synthetic MouseEvent construction.
    }
    if (typeof control.click === 'function') control.click();
  }

  function stopCurrentGeneration() {
    const host = getHostWindow();
    const context = getTavernContext();
    const functionCandidates = [
      [context, 'stopGeneration'],
      [context, 'abortGeneration'],
      [context, 'cancelGeneration'],
      [host, 'stopGeneration'],
      [host, 'abortGeneration'],
      [host, 'cancelGeneration'],
    ];
    for (const [owner, name] of functionCandidates) {
      if (!owner || typeof owner[name] !== 'function') continue;
      try {
        owner[name]();
        return { ok: true, method: `${name}()` };
      } catch (error) {
        console.warn(`[${SCRIPT_NAME}] 停止函数 ${name} 调用失败`, error);
      }
    }
    const control = findStopControl();
    if (control) {
      clickStopControl(control);
      return { ok: true, method: `点击 ${control.id ? `#${control.id}` : '停止按钮'}` };
    }
    return { ok: false, error: '未找到停止生成入口' };
  }

  function scheduleAction(callback, delayMs) {
    const timer = setTimeout(() => {
      actionTimers = actionTimers.filter((item) => item !== timer);
      callback();
    }, Math.max(0, delayMs));
    actionTimers.push(timer);
    return timer;
  }

  function getNumericMessageId(message) {
    const node = message && message.node;
    if (!node) return null;
    const rawMesid = node.getAttribute('mesid') || node.dataset && (node.dataset.mesid || node.dataset.messageId);
    const numericMesid = Number(rawMesid);
    return Number.isFinite(numericMesid) ? numericMesid : null;
  }

  function getWritableMessageRecord(message) {
    const context = getTavernContext();
    const index = getNumericMessageId(message);
    if (!context || !Array.isArray(context.chat) || !Number.isFinite(index)) {
      return { ok: false, error: '无法定位酒馆内部消息数据' };
    }
    const record = context.chat[index];
    if (!record) {
      return { ok: false, error: `无法读取第 ${index + 1} 楼消息数据` };
    }
    if (typeof context.updateMessageBlock !== 'function') {
      return { ok: false, error: '酒馆未暴露 updateMessageBlock，已取消自动截断' };
    }
    return { ok: true, context, index, record };
  }

  function getRecordText(record) {
    if (!record) return '';
    const swipeIndex = Number(record.swipe_id);
    if (Array.isArray(record.swipes) && Number.isFinite(swipeIndex) && typeof record.swipes[swipeIndex] === 'string') {
      return record.swipes[swipeIndex];
    }
    return String(record.mes || '');
  }

  function detectDoubleThinkingInText(value) {
    const text = String(value || '');
    const contentClose = findTag(text, 'content', 0, true);
    if (!contentClose) {
      return { hasContentClose: false, trigger: false };
    }
    const thinking = findTag(text, 'thinking', contentClose.index + contentClose.length, false);
    if (!thinking) {
      return { hasContentClose: true, trigger: false };
    }
    return {
      hasContentClose: true,
      trigger: true,
      thinkingIndex: thinking.index,
      snippet: getSnippetBefore(text, thinking.index),
    };
  }

  function applyRecordText(record, text) {
    const value = String(text || '');
    const swipeIndex = Number(record.swipe_id);
    record.mes = value;
    if (Array.isArray(record.swipes) && Number.isFinite(swipeIndex) && typeof record.swipes[swipeIndex] === 'string') {
      record.swipes[swipeIndex] = value;
    }
    if (record.extra && typeof record.extra.display_text === 'string') {
      const displayDetection = detectDoubleThinkingInText(record.extra.display_text);
      if (displayDetection.trigger) {
        record.extra.display_text = record.extra.display_text.slice(0, displayDetection.thinkingIndex);
      }
    }
  }

  async function saveChatSafely(context) {
    if (!context || typeof context.saveChat !== 'function') return;
    try {
      await Promise.resolve(context.saveChat());
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] 保存聊天失败`, error);
    }
  }

  function refreshMessageBlock(info) {
    info.context.updateMessageBlock(info.index, info.record);
  }

  function findContinueControl() {
    const doc = getHostDocument();
    const selectors = [
      '#mes_continue',
      'button[title*="Continue"]',
      'button[title*="继续"]',
      'button[aria-label*="Continue"]',
      'button[aria-label*="继续"]',
      '[data-action="continue"]',
    ];
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      if (node && isElementVisible(node) && !node.disabled) return node;
    }
    return null;
  }

  function continueCurrentGeneration() {
    if (isGenerationActive() === true) {
      return { ok: false, error: '当前仍在生成，已取消自动续写' };
    }
    const control = findContinueControl();
    if (control) {
      clickStopControl(control);
      return { ok: true, method: `点击 ${control.id ? `#${control.id}` : '继续按钮'}` };
    }
    const context = getTavernContext();
    if (context && typeof context.generate === 'function') {
      try {
        const result = context.generate('continue');
        if (result && typeof result.catch === 'function') {
          result.catch((error) => console.warn(`[${SCRIPT_NAME}] 自动续写失败`, error));
        }
        return { ok: true, method: 'generate("continue")' };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    }
    return { ok: false, error: '未找到继续生成入口' };
  }

  function createTask(message, state, detection, floor, logId, settings) {
    const task = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      key: getMessageKey(message),
      rawMesid: floor.rawMesid || '',
      floorLabel: floor.floorLabel,
      logId,
      snippet: detection.snippet || '',
      stopDelaySeconds: settings.stopDelaySeconds,
      continueDelaySeconds: settings.continueDelaySeconds,
      autoContinue: settings.autoContinue && !state.autoContinueUsed,
    };
    runtime.activeTasks.set(task.id, task);
    state.activeTaskId = task.id;
    return task;
  }

  function cancelTask(task, reason) {
    if (!task) return;
    runtime.activeTasks.delete(task.id);
    updateLog(task.logId, { truncateError: reason });
    setGuardStatus(reason, 'warning');
  }

  function schedulePostStopProcessing(message, state, detection, floor, logId, settings) {
    if (!settings.autoTruncate) {
      updateLog(logId, {
        truncateStatus: '未开启自动截断',
        continueStatus: '未开启自动截断，跳过续写',
      });
      return;
    }
    if (state.autoTruncateUsed) {
      updateLog(logId, {
        truncateStatus: '本楼已自动截断过一次，为避免误删续写内容，跳过再次截断',
        continueStatus: '跳过再次截断，因此不自动续写',
      });
      setGuardStatus(`${floor.floorLabel} 已自动截断过一次；本次只停止，不再自动删除。`, 'warning');
      return;
    }
    const task = createTask(message, state, detection, floor, logId, settings);
    const delayMs = task.stopDelaySeconds * 1000;
    updateLog(logId, { truncateStatus: `等待 ${task.stopDelaySeconds} 秒后截断` });
    setGuardStatus(`已停止 ${floor.floorLabel}；等待 ${task.stopDelaySeconds} 秒后删除第二个 <thinking> 起的内容。`, 'warning');
    scheduleAction(() => {
      runTruncateTask(task).catch((error) => {
        console.warn(`[${SCRIPT_NAME}] 自动截断失败`, error);
        cancelTask(task, `自动截断失败：${error.message || error}`);
      });
    }, delayMs);
  }

  async function runTruncateTask(task) {
    if (!runtime.activeTasks.has(task.id)) return;
    const state = runtime.states.get(task.key);
    const latest = getLatestAssistantMessage();
    if (!latest || getMessageKey(latest) !== task.key) {
      cancelTask(task, '当前最后一楼已变化，取消自动截断');
      return;
    }
    if (isGenerationActive() === true) {
      cancelTask(task, '等待后仍处于生成中，取消自动截断');
      return;
    }
    const writable = getWritableMessageRecord(latest);
    if (!writable.ok) {
      cancelTask(task, writable.error);
      return;
    }
    if (task.rawMesid && String(writable.index) !== String(task.rawMesid)) {
      cancelTask(task, '消息楼层编号变化，取消自动截断');
      return;
    }
    const rawText = getRecordText(writable.record);
    const detection = detectDoubleThinkingInText(rawText);
    if (!detection.trigger) {
      cancelTask(task, '保存数据中未找到第二个 <thinking>，取消自动截断');
      return;
    }
    const truncated = rawText.slice(0, detection.thinkingIndex);
    if (truncated === rawText) {
      cancelTask(task, '截断点无效，取消自动截断');
      return;
    }
    applyRecordText(writable.record, truncated);
    refreshMessageBlock(writable);
    await saveChatSafely(writable.context);
    if (state) {
      state.truncated = true;
      state.autoTruncateUsed = true;
      state.lastLength = truncated.length;
      state.contentClosed = true;
    }
    const removedCount = rawText.length - truncated.length;
    updateLog(task.logId, {
      snippet: detection.snippet || task.snippet,
      truncateMethod: `已删除 ${removedCount} 字符`,
      truncateError: '',
      truncatedAt: new Date().toISOString(),
    });
    setGuardStatus(`已精确删除 ${task.floorLabel} 第二个 <thinking> 起的 ${removedCount} 个字符。`, 'warning');

    if (task.autoContinue) {
      updateLog(task.logId, { continueStatus: `等待 ${task.continueDelaySeconds} 秒后续写` });
      scheduleAction(() => runContinueTask(task), task.continueDelaySeconds * 1000);
    } else {
      updateLog(task.logId, { continueStatus: '未开启自动续写，或本楼已自动续写过一次' });
      runtime.activeTasks.delete(task.id);
    }
  }

  function runContinueTask(task) {
    if (!runtime.activeTasks.has(task.id)) return;
    const state = runtime.states.get(task.key);
    const latest = getLatestAssistantMessage();
    if (!latest || getMessageKey(latest) !== task.key) {
      updateLog(task.logId, { continueError: '当前最后一楼已变化，取消自动续写' });
      setGuardStatus('当前最后一楼已变化，取消自动续写。', 'warning');
      runtime.activeTasks.delete(task.id);
      return;
    }
    const result = continueCurrentGeneration();
    if (result.ok) {
      if (state) {
        state.stopped = false;
        state.autoContinueUsed = true;
        state.lastLength = getMaxSourceLength(getMessageSources(latest));
        state.contentClosed = true;
      }
      updateLog(task.logId, {
        continueMethod: result.method,
        continueStatus: '',
        continuedAt: new Date().toISOString(),
      });
      setGuardStatus(`已为 ${task.floorLabel} 触发自动续写；本楼不会再次自动续写。`, 'warning');
    } else {
      updateLog(task.logId, { continueError: result.error });
      setGuardStatus(`自动续写失败：${result.error}`, 'error');
    }
    runtime.activeTasks.delete(task.id);
  }

  function getChatContainer() {
    const doc = getHostDocument();
    return doc.getElementById('chat')
      || doc.querySelector('#chat')
      || doc.querySelector('[data-testid="chat"]')
      || doc.body;
  }

  function isUserMessage(messageNode) {
    if (!messageNode) return false;
    const classList = messageNode.classList;
    if (classList.contains('user_mes') || classList.contains('user-message')) return true;
    if (messageNode.dataset && (messageNode.dataset.isUser === 'true' || messageNode.dataset.role === 'user')) return true;
    const attr = String(messageNode.getAttribute('is_user') || messageNode.getAttribute('data-is-user') || '').toLowerCase();
    return attr === 'true' || attr === '1';
  }

  function getMessageContentNode(messageNode) {
    if (!messageNode) return null;
    return messageNode.querySelector('.mes_text')
      || messageNode.querySelector('.message-text')
      || messageNode.querySelector('[data-message-text]')
      || messageNode;
  }

  function getMessageNodes() {
    const root = getChatContainer();
    if (!root) return [];
    const nodes = Array.from(root.querySelectorAll('.mes'));
    if (nodes.length) return nodes.filter((node) => node.isConnected && isElementVisible(node));
    return Array.from(root.querySelectorAll('[data-message-id], .message')).filter((node) => node.isConnected && isElementVisible(node));
  }

  function getLatestAssistantMessage() {
    const nodes = getMessageNodes();
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (isUserMessage(node)) continue;
      const contentNode = getMessageContentNode(node);
      if (!contentNode) continue;
      return { node, contentNode, index, nodes };
    }
    return null;
  }

  function getWeakNodeId(node) {
    if (!runtime.weakIds.has(node)) {
      runtime.weakIds.set(node, runtime.nextWeakId);
      runtime.nextWeakId += 1;
    }
    return runtime.weakIds.get(node);
  }

  function getMessageKey(message) {
    const node = message && message.node;
    if (!node) return 'none';
    const mesid = node.getAttribute('mesid') || node.dataset && (node.dataset.mesid || node.dataset.messageId);
    if (mesid != null && String(mesid).trim() !== '') return `mesid:${String(mesid).trim()}`;
    return `node:${getWeakNodeId(node)}`;
  }

  function getFloorInfo(message) {
    const node = message && message.node;
    if (!node) return { floorLabel: '未知楼层', floorNumber: null };
    const rawMesid = node.getAttribute('mesid') || node.dataset && (node.dataset.mesid || node.dataset.messageId);
    const numericMesid = Number(rawMesid);
    if (Number.isFinite(numericMesid)) {
      return {
        floorLabel: `第 ${numericMesid + 1} 楼`,
        floorNumber: numericMesid + 1,
        rawMesid: String(rawMesid),
      };
    }
    const all = message.nodes || getMessageNodes();
    const index = all.indexOf(node);
    if (index >= 0) {
      return {
        floorLabel: `第 ${index + 1} 楼`,
        floorNumber: index + 1,
      };
    }
    return { floorLabel: '未知楼层', floorNumber: null };
  }

  function getContextMessageText(message) {
    const context = getTavernContext();
    const chat = context && Array.isArray(context.chat) ? context.chat : null;
    if (!chat || !chat.length || !message || !message.node) return '';
    const rawMesid = message.node.getAttribute('mesid') || message.node.dataset && message.node.dataset.mesid;
    const numericMesid = Number(rawMesid);
    const record = Number.isFinite(numericMesid) ? chat[numericMesid] : chat[chat.length - 1];
    if (!record) return '';
    return String(record.mes || record.message || record.text || '');
  }

  function getMessageSources(message) {
    const contentNode = message && message.contentNode;
    if (!contentNode) return [];
    const sources = [
      { kind: 'raw', value: getContextMessageText(message) },
      { kind: 'text', value: contentNode.textContent || '' },
      { kind: 'html', value: contentNode.innerHTML || '' },
    ];
    const seen = new Set();
    return sources.filter((source) => {
      const value = String(source.value || '');
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function getMaxSourceLength(sources) {
    return sources.reduce((max, source) => Math.max(max, String(source.value || '').length), 0);
  }

  function normalizeTagSource(value) {
    return decodeHtmlEntities(String(value || ''))
      .replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function findTag(source, tagName, startIndex, closing) {
    const name = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = closing
      ? new RegExp(`<\\s*\\/\\s*${name}\\s*>`, 'i')
      : new RegExp(`<\\s*${name}(?:\\s|>|\\/)`, 'i');
    const slice = source.slice(Math.max(0, startIndex || 0));
    const match = pattern.exec(slice);
    if (!match) return null;
    return {
      index: Math.max(0, startIndex || 0) + match.index,
      length: match[0].length,
      text: match[0],
    };
  }

  function stripTagsForSnippet(value) {
    return decodeHtmlEntities(String(value || ''))
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, '');
  }

  function getSnippetBefore(source, index) {
    const before = normalizeTagSource(source).slice(Math.max(0, index - 500), index);
    const readable = stripTagsForSnippet(before);
    if (readable) return readable.slice(-10);
    return before.replace(/\s+/g, '').slice(-10);
  }

  function detectDoubleThinking(sources) {
    let sawContentClose = false;
    let contentCloseSourceKind = '';
    for (const source of sources) {
      const normalized = normalizeTagSource(source.value);
      const contentClose = findTag(normalized, 'content', 0, true);
      if (!contentClose) continue;
      sawContentClose = true;
      if (!contentCloseSourceKind) contentCloseSourceKind = source.kind;
      const thinking = findTag(normalized, 'thinking', contentClose.index + contentClose.length, false);
      if (!thinking) continue;
      return {
        hasContentClose: true,
        trigger: true,
        sourceKind: source.kind,
        thinkingIndex: thinking.index,
        snippet: getSnippetBefore(normalized, thinking.index),
      };
    }
    return {
      hasContentClose: sawContentClose,
      trigger: false,
      sourceKind: contentCloseSourceKind,
    };
  }

  function primeCurrentMessageBaseline() {
    const message = getLatestAssistantMessage();
    if (!message) return;
    const key = getMessageKey(message);
    const sources = getMessageSources(message);
    const detection = detectDoubleThinking(sources);
    runtime.states.set(key, {
      lastLength: getMaxSourceLength(sources),
      contentClosed: detection.hasContentClose,
      stopped: false,
      autoContinueUsed: false,
      autoTruncateUsed: false,
      createdAt: Date.now(),
    });
  }

  function handleTrigger(message, state, detection) {
    state.stopped = true;
    const floor = getFloorInfo(message);
    const stopResult = stopCurrentGeneration();
    const settings = loadSettings();
    const entry = {
      floorLabel: floor.floorLabel,
      floorNumber: floor.floorNumber,
      rawMesid: floor.rawMesid || '',
      snippet: detection.snippet || '',
      sourceKind: detection.sourceKind || '',
      stopMethod: stopResult.ok ? stopResult.method : '',
      stopError: stopResult.ok ? '' : stopResult.error,
      truncateStatus: stopResult.ok && settings.autoTruncate ? `等待 ${settings.stopDelaySeconds} 秒后截断` : '未开启自动截断',
      continueStatus: settings.autoContinue ? `截断后等待 ${settings.continueDelaySeconds} 秒续写` : '未开启自动续写',
    };
    const logId = addLog(entry);
    const messageText = stopResult.ok
      ? `检测到 </content> 后的新 <thinking>，已停止：${floor.floorLabel}`
      : `检测到新 <thinking>，但未找到停止入口：${floor.floorLabel}`;
    setGuardStatus(messageText, stopResult.ok ? 'warning' : 'error');
    notify(stopResult.ok ? 'warning' : 'error', messageText);
    if (stopResult.ok) {
      schedulePostStopProcessing(message, state, detection, floor, logId, settings);
    }
  }

  function inspectCurrentMessage(reason) {
    if (runtime.checking) return;
    runtime.checking = true;
    try {
      const settings = loadSettings();
      if (!settings.enabled) {
        setGuardStatus('守护已关闭，浮窗仍会常驻。', 'warning');
        return;
      }

      const message = getLatestAssistantMessage();
      if (!message) {
        setGuardStatus('守护已开启，尚未找到可监听的回复楼层。', 'muted');
        return;
      }

      const key = getMessageKey(message);
      const sources = getMessageSources(message);
      const maxLength = getMaxSourceLength(sources);
      const generationActive = isGenerationActive() === true;
      const detection = detectDoubleThinking(sources);
      let state = runtime.states.get(key);

      if (state && state.activeTaskId && runtime.activeTasks.has(state.activeTaskId)) {
        return;
      }

      if (!generationActive) {
        runtime.states.set(key, {
          lastLength: maxLength,
          contentClosed: detection.hasContentClose,
          stopped: false,
          autoContinueUsed: state && state.autoContinueUsed || false,
          autoTruncateUsed: state && state.autoTruncateUsed || false,
          createdAt: state && state.createdAt || Date.now(),
          baselineOnly: true,
        });
        setGuardStatus('守护已开启；当前没有生成，历史楼层只建立基线，不会触发停止。', 'muted');
        return;
      }

      if (!state) {
        state = {
          lastLength: maxLength,
          contentClosed: detection.hasContentClose,
          stopped: false,
          autoContinueUsed: false,
          autoTruncateUsed: false,
          createdAt: Date.now(),
          baselineOnly: false,
        };
        runtime.states.set(key, state);
        if (detection.trigger) {
          handleTrigger(message, state, detection);
          return;
        }
        if (reason === 'baseline' || reason === 'poll') {
          setGuardStatus('守护已开启，正在监听当前生成楼层。', 'muted');
          return;
        }
        return;
      }

      if (maxLength <= state.lastLength && reason !== 'force') return;
      state.lastLength = maxLength;
      if (state.stopped) return;

      if (detection.hasContentClose && !state.contentClosed) {
        state.contentClosed = true;
        const floor = getFloorInfo(message);
        setGuardStatus(`已看到 ${floor.floorLabel} 的 </content>，开始警戒后续 <thinking>。`, 'muted');
      }
      if (detection.trigger) {
        handleTrigger(message, state, detection);
      }
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] 守护检查失败`, error);
      setGuardStatus(`守护检查失败：${error.message || error}`, 'error');
    } finally {
      runtime.checking = false;
    }
  }

  function bindOutputWatcher() {
    const doc = getHostDocument();
    const target = getChatContainer();
    if (!target || !doc.body) {
      if (!outputBindTimer) {
        outputBindTimer = setTimeout(() => {
          outputBindTimer = null;
          bindOutputWatcher();
        }, 300);
      }
      return;
    }

    if (outputObserver && runtime.observedTarget === target) return;
    if (outputObserver) outputObserver.disconnect();

    try {
      const Observer = getHostWindow().MutationObserver || window.MutationObserver;
      if (Observer) {
        outputObserver = new Observer(() => {
          inspectCurrentMessage('mutation');
        });
        outputObserver.observe(target, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        runtime.observedTarget = target;
      }
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] 输出监听启动失败`, error);
    }

    if (!outputPollTimer) {
      outputPollTimer = setInterval(() => {
        const latestTarget = getChatContainer();
        if (latestTarget && latestTarget !== runtime.observedTarget) bindOutputWatcher();
        inspectCurrentMessage('poll');
      }, 450);
    }
  }

  function installFloatingButtonGuard() {
    const doc = getHostDocument();
    if (!doc || !doc.body) return;
    if (bodyRepairObserver && doc.body.dataset.thRemoveDoubleThinkingGuardVersion === SCRIPT_VERSION) return;

    if (bodyRepairObserver) {
      bodyRepairObserver.disconnect();
      bodyRepairObserver = null;
    }
    doc.body.dataset.thRemoveDoubleThinkingGuardVersion = SCRIPT_VERSION;

    const repair = () => {
      try {
        injectStyle();
        ensureFloatingButton();
      } catch (error) {
        console.warn(`[${SCRIPT_NAME}] 重建浮窗失败`, error);
      }
    };
    const scheduleRepair = () => {
      if (bodyRepairTimer) return;
      bodyRepairTimer = setTimeout(() => {
        bodyRepairTimer = null;
        repair();
      }, 360);
    };

    [900, 2200, 5200, 9000, 15000].forEach((delay) => {
      const timer = setTimeout(repair, delay);
      floatingGuardTimers.push(timer);
    });

    try {
      const Observer = getHostWindow().MutationObserver || window.MutationObserver;
      if (!Observer) return;
      bodyRepairObserver = new Observer(scheduleRepair);
      bodyRepairObserver.observe(doc.body, { childList: true, subtree: true });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] 浮窗守护启动失败`, error);
    }
  }

  function registerTavernHelperButton() {
    const handler = () => {
      try {
        togglePanel();
      } catch (error) {
        console.error(error);
        notify('error', `打开失败：${error.message || error}`);
      }
    };
    try {
      if (typeof appendInexistentScriptButtons === 'function') {
        appendInexistentScriptButtons([{ name: BUTTON_NAME, visible: true }]);
      }
      if (typeof eventOnButton === 'function') {
        eventOnButton(BUTTON_NAME, handler);
      }
      if (typeof getButtonEvent === 'function' && typeof eventOn === 'function') {
        eventOn(getButtonEvent(BUTTON_NAME), handler);
      }
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] 注册酒馆助手按钮失败，继续使用浮窗`, error);
    }
  }

  function register() {
    claimGlobalInstance();
    const doc = getHostDocument();
    if (!doc.head || !doc.body) {
      if (!bootRetryTimer) {
        bootRetryTimer = setTimeout(() => {
          bootRetryTimer = null;
          register();
        }, 120);
      }
      return;
    }
    injectStyle();
    ensureFloatingButton();
    installFloatingButtonGuard();
    registerTavernHelperButton();
    bindOutputWatcher();
    primeCurrentMessageBaseline();
    setGuardStatus(loadSettings().enabled ? '守护已开启，等待正在生成的回复。' : '守护已关闭，浮窗仍会常驻。', loadSettings().enabled ? 'muted' : 'warning');
  }

  window.addEventListener('pagehide', stopInstance, { once: true });
  window.addEventListener('unload', stopInstance, { once: true });

  const initialDocument = getHostDocument();
  if (initialDocument.readyState === 'loading') {
    initialDocument.addEventListener('DOMContentLoaded', register, { once: true });
  } else {
    register();
  }
})();
