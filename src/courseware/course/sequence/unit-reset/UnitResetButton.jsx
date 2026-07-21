import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthenticatedHttpClient } from '@edx/frontend-platform/auth';
import { getConfig } from '@edx/frontend-platform';

import './UnitResetButton.scss';

function getLmsBaseUrl() {
  const config = getConfig();
  return config.LMS_BASE_URL || config.LMS_BASE_URL_LEGACY || window.location.origin.replace('apps.', '');
}

function formatWaitTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours} giờ ${minutes} phút ${secs} giây`;
  if (minutes <= 0) return `${secs} giây`;
  return `${minutes} phút ${secs} giây`;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  if (hours > 0) return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

function secondsUntil(dateString) {
  if (!dateString) return null;
  const target = new Date(dateString).getTime();
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.floor((target - Date.now()) / 1000));
}

function refreshTimerFromWallClock(current) {
  if (!current) return current;
  const nextRemaining = current.expiresAt ? secondsUntil(current.expiresAt) : current.remainingSeconds;
  const nextCooldown = current.resetAvailableAt ? secondsUntil(current.resetAvailableAt) : current.cooldownSeconds;
  return {
    ...current,
    remainingSeconds: nextRemaining === null || nextRemaining === undefined ? current.remainingSeconds : nextRemaining,
    cooldownSeconds: nextCooldown === null || nextCooldown === undefined ? current.cooldownSeconds : nextCooldown,
  };
}

function normalizeTimerPayload(data) {
  const session = data?.session || data?.quiz_session || {};
  const config = data?.config || session?.config || {};
  const rawRemaining = data?.remaining_seconds
    ?? data?.time_remaining_seconds
    ?? data?.remaining_time_seconds
    ?? session?.remaining_seconds
    ?? session?.time_remaining_seconds
    ?? secondsUntil(data?.expires_at || session?.expires_at);
  const rawCooldown = data?.cooldown_remaining_seconds
    ?? data?.reset_wait_seconds
    ?? data?.reset_remaining_seconds
    ?? data?.remaining_cooldown_seconds
    ?? data?.wait_seconds
    ?? session?.cooldown_remaining_seconds
    ?? session?.reset_wait_seconds
    ?? session?.reset_remaining_seconds
    ?? secondsUntil(data?.reset_available_at || session?.reset_available_at);
  const expiresAt = data?.expires_at || session?.expires_at || null;
  const status = String(data?.status || session?.status || '').toUpperCase();
  const timerEnabled = Boolean(
    data?.timer_enabled
    || data?.custom_timer_enabled
    || data?.enabled
    || data?.configured
    || config?.enabled
    || expiresAt
    || (rawRemaining !== null && rawRemaining !== undefined),
  );
  return {
    timerEnabled,
    status,
    remainingSeconds: rawRemaining === null || rawRemaining === undefined ? null : Math.max(0, Math.floor(Number(rawRemaining || 0))),
    cooldownSeconds: rawCooldown === null || rawCooldown === undefined ? 0 : Math.max(0, Math.floor(Number(rawCooldown || 0))),
    // v25.9.16.5.32 policy: a configured timed quiz always auto-submits
    // and locks locally after timeout. This prevents old Quiz configs that were
    // created with unchecked UI options from silently disabling auto-submit.
    autoSubmitOnTimeout: true,
    lockAfterTimeout: true,
    expiresAt,
    resetAvailableAt: data?.reset_available_at || session?.reset_available_at || null,
    serverNow: data?.server_now || session?.server_now || null,
    message: data?.message || session?.message || '',
  };
}

function loadRuntimeScript(lmsBaseUrl) {
  const scriptId = 'openedx-unit-reset-quiz-runtime-js';
  if (document.getElementById(scriptId)) return;
  const script = document.createElement('script');
  script.id = scriptId;
  script.async = true;
  script.src = `${lmsBaseUrl}/api/unit-reset/v1/quiz-session/runtime.js`;
  document.body.appendChild(script);
}

function getTimerSessionToken(data) {
  const session = data?.session || data?.quiz_session || {};
  return data?.session_id
    || data?.quiz_session_id
    || data?.id
    || session?.id
    || data?.attempt_no
    || session?.attempt_no
    || data?.started_at
    || session?.started_at
    || data?.expires_at
    || session?.expires_at
    || 'active';
}

function hasFreshQuizSession(normalized) {
  return normalized?.timerEnabled && ['ACTIVE', 'SUBMITTING'].includes(String(normalized.status || '').toUpperCase());
}

function getFrameSrc(frame) {
  if (!frame) return '';
  return frame.getAttribute('src') || frame.src || '';
}

function looksLikeUnitIframe(frame, unitUsageKey) {
  const rawSrc = getFrameSrc(frame);
  if (!rawSrc) return false;
  const decodedSrc = (() => {
    try { return decodeURIComponent(rawSrc); } catch (error) { return rawSrc; }
  })();
  return decodedSrc.includes('/xblock/')
    || decodedSrc.includes('block-v1:')
    || decodedSrc.includes(unitUsageKey || '')
    || frame.id === 'unit-iframe';
}

function getUnitIframes(unitUsageKey) {
  const frames = Array.from(document.querySelectorAll('iframe'));
  const byId = document.getElementById('unit-iframe');
  const candidates = [];
  if (byId) candidates.push(byId);
  frames.forEach((frame) => {
    if (looksLikeUnitIframe(frame, unitUsageKey) && !candidates.includes(frame)) candidates.push(frame);
  });
  return candidates;
}


function targetOriginForFrame(frame) {
  const rawSrc = getFrameSrc(frame);
  if (!rawSrc) return window.location.origin;
  try { return new URL(rawSrc, window.location.href).origin; } catch (error) { return window.location.origin; }
}


function normalizeThemeVariant(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('dark')) return 'dark';
  if (raw.includes('light')) return 'light';
  return '';
}

function themeVariantFromPersistedPreference() {
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = String(window.localStorage.key(index) || '');
      if (!/(paragon|theme|appearance|color.?scheme)/i.test(key)) continue;
      const rawValue = window.localStorage.getItem(key);
      const simpleValue = String(rawValue || '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (simpleValue === 'dark' || simpleValue === 'light') return simpleValue;
      try {
        const parsed = JSON.parse(rawValue);
        const candidates = [
          parsed?.themeVariant,
          parsed?.theme_variant,
          parsed?.variant,
          parsed?.theme,
          parsed?.appearance,
          parsed?.colorScheme,
          parsed?.color_scheme,
          parsed?.value,
        ];
        const matched = candidates.map(normalizeThemeVariant).find(Boolean);
        if (matched) return matched;
      } catch (error) { /* value is not JSON */ }
    }
  } catch (error) { /* localStorage can be blocked */ }
  return '';
}

function themeVariantFromActiveStylesheets() {
  try {
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    const active = links.filter((link) => {
      if (link.disabled) return false;
      const media = String(link.media || '').trim();
      if (!media || media.toLowerCase() === 'all') return true;
      if (media.toLowerCase() === 'not all') return false;
      try { return window.matchMedia(media).matches; } catch (error) { return true; }
    });
    const darkLink = active.find((link) => /(^|[\/_.-])dark([\/_.-]|$)/i.test(String(link.href || '')));
    if (darkLink) return 'dark';
    const lightLink = active.find((link) => /(^|[\/_.-])light([\/_.-]|$)/i.test(String(link.href || '')));
    if (lightLink) return 'light';
  } catch (error) { /* ignore stylesheet lifecycle races */ }
  return '';
}

function themeVariantFromRenderedSurface() {
  const candidates = [
    document.querySelector('main'),
    document.querySelector('#root'),
    document.body,
    document.documentElement,
  ].filter(Boolean);
  for (const element of candidates) {
    try {
      const value = window.getComputedStyle(element).backgroundColor;
      const match = String(value || '').match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)/i);
      if (!match) continue;
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      if (alpha < 0.5) continue;
      const [red, green, blue] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
      return luminance < 0.45 ? 'dark' : 'light';
    } catch (error) { /* ignore */ }
  }
  return '';
}

function detectHostThemeVariant() {
  const html = document.documentElement;
  const body = document.body;
  const explicit = html?.getAttribute('data-paragon-theme-variant')
    || body?.getAttribute('data-paragon-theme-variant')
    || html?.getAttribute('data-bs-theme')
    || body?.getAttribute('data-bs-theme')
    || html?.getAttribute('data-theme')
    || body?.getAttribute('data-theme');
  const explicitVariant = normalizeThemeVariant(explicit);
  if (explicitVariant) return explicitVariant;

  const persisted = themeVariantFromPersistedPreference();
  if (persisted) return persisted;

  const classText = `${html?.className || ''} ${body?.className || ''}`.toLowerCase();
  const classVariant = normalizeThemeVariant(classText);
  if (classVariant) return classVariant;

  const stylesheetVariant = themeVariantFromActiveStylesheets();
  if (stylesheetVariant) return stylesheetVariant;

  return themeVariantFromRenderedSurface();
}

function postIframeUiContract(frame, unitUsageKey, reason = 'sync') {
  if (!frame?.contentWindow) return;
  const themeVariant = detectHostThemeVariant();
  const origin = targetOriginForFrame(frame);
  try {
    // Never guess from prefers-color-scheme here. The MFE theme preference is
    // authoritative and may intentionally differ from the operating system.
    if (themeVariant) {
      frame.contentWindow.postMessage({
        type: 'AI_MFE_THEME_SYNC',
        theme: themeVariant,
        theme_variant: themeVariant,
        unit_usage_key: unitUsageKey,
        reason,
      }, origin);
    }
    frame.contentWindow.postMessage({
      type: 'AI_MFE_REQUEST_RESIZE',
      unit_usage_key: unitUsageKey,
      reason,
    }, origin);
  } catch (error) { /* ignore cross-origin lifecycle races */ }
}

function postActiveSessionReloadToFrames({ unitUsageKey, reason, token }) {
  const message = {
    type: 'AI_QUIZ_ACTIVE_SESSION_READY_RELOAD',
    unit_usage_key: unitUsageKey,
    reason,
    token: String(token || Date.now()),
  };
  Array.from(document.querySelectorAll('iframe')).forEach((frame) => {
    try { frame.contentWindow?.postMessage(message, targetOriginForFrame(frame)); } catch (error) { /* ignore cross-origin frame access */ }
  });
}

function reloadFrameWithNonce(frame, { unitUsageKey, reason, token }) {
  const rawSrc = getFrameSrc(frame);
  if (!rawSrc) return false;
  const url = new URL(rawSrc, window.location.href);
  url.searchParams.set('unit_reset_nonce', String(token || Date.now()));
  url.searchParams.set('unit_reset_reason', reason);
  url.searchParams.set('unit_reset_unit', unitUsageKey || '');

  // Replace the iframe element instead of only assigning src. Some Learning MFE
  // versions keep the old XBlock DOM alive after timeout/reset; cloning forces a
  // clean iframe document without touching native Open edX Submit/Check buttons.
  const nextFrame = frame.cloneNode(false);
  nextFrame.src = url.toString();
  nextFrame.dataset.openedxUnitResetReloadReason = reason;
  try {
    frame.parentNode?.insertBefore(nextFrame, frame.nextSibling);
    frame.parentNode?.removeChild(frame);
  } catch (error) {
    frame.src = url.toString();
  }
  return true;
}

function reloadUnitIframeOnce({ courseId, unitUsageKey, data, reason }) {
  const token = getTimerSessionToken(data) || Date.now();
  const storageKey = `openedx-unit-reset:iframe-reloaded:${courseId}:${unitUsageKey}:${reason}:${token}`;

  try {
    if (window.sessionStorage.getItem(storageKey) === '1') return false;
    window.sessionStorage.setItem(storageKey, '1');
  } catch (error) {
    // sessionStorage can be unavailable in strict browser modes. Reloading the iframe is still safe.
  }

  const reloadNow = () => {
    postActiveSessionReloadToFrames({ unitUsageKey, reason, token });
    const iframes = getUnitIframes(unitUsageKey);
    let didReload = false;
    iframes.forEach((frame) => {
      didReload = reloadFrameWithNonce(frame, { unitUsageKey, reason, token }) || didReload;
    });
    return didReload;
  };

  if (reloadNow()) return true;

  // The UnitResetButton can mount before the unit iframe exists. Retry briefly
  // instead of immediately reloading the whole MFE, which can recreate the same
  // race where /xblock renders before quiz-session/start.
  let attempts = 0;
  const retry = window.setInterval(() => {
    attempts += 1;
    if (reloadNow()) {
      window.clearInterval(retry);
      return;
    }
    if (attempts >= 20) {
      window.clearInterval(retry);
      window.location.reload();
    }
  }, 250);
  return true;
}

async function startQuizSession(client, lmsBaseUrl, quizSessionPayload) {
  return client.post(`${lmsBaseUrl}/api/unit-reset/v1/quiz-session/start`, quizSessionPayload);
}

function broadcastAutoSubmitToProblemFrames(quizSessionPayload) {
  const message = {
    type: 'AI_QUIZ_TIMEOUT_API_SUBMIT',
    course_id: quizSessionPayload?.course_id,
    sequence_usage_key: quizSessionPayload?.sequence_usage_key,
    unit_usage_key: quizSessionPayload?.unit_usage_key,
  };
  Array.from(document.querySelectorAll('iframe')).forEach((frame) => {
    try { frame.contentWindow?.postMessage(message, targetOriginForFrame(frame)); } catch (error) { /* ignore cross-origin frame access */ }
  });
}

export default function UnitResetButton({ courseId, sequenceUsageKey, unitUsageKey }) {
  const [loading, setLoading] = useState(false);
  const [timerLoading, setTimerLoading] = useState(false);
  const [timerUnavailable, setTimerUnavailable] = useState(false);
  const [timer, setTimer] = useState(null);
  const timeoutHandledRef = useRef(false);
  const initialStartDoneRef = useRef(false);

  const quizSessionPayload = {
    course_id: courseId,
    sequence_usage_key: sequenceUsageKey,
    unit_usage_key: unitUsageKey,
  };

  const loadTimerStatus = useCallback(async ({ startIfNeeded = false } = {}) => {
    if (!courseId || !unitUsageKey || timerUnavailable) return;
    const client = getAuthenticatedHttpClient();
    const lmsBaseUrl = getLmsBaseUrl();
    try {
      setTimerLoading(true);
      if (startIfNeeded) {
        try {
          const startResponse = await startQuizSession(client, lmsBaseUrl, quizSessionPayload);
          const normalized = normalizeTimerPayload(startResponse?.data);
          setTimer(normalized);
          if (normalized.timerEnabled) {
            loadRuntimeScript(lmsBaseUrl);
            // Do not hard-remount the iframe on the first page entry. In Ulmo MFE
            // this can race the initial XBlock render and leave a blank unit until F5.
            // Hard remount is reserved for explicit reset/start after "Làm lại bài".
            initialStartDoneRef.current = true;
          }
          return;
        } catch (startError) {
          if (![404, 405].includes(startError?.response?.status)) throw startError;
        }
      }
      const response = await client.get(`${lmsBaseUrl}/api/unit-reset/v1/quiz-session/status`, { params: quizSessionPayload });
      const normalized = normalizeTimerPayload(response?.data);
      setTimer(normalized);
      if (normalized.timerEnabled) loadRuntimeScript(lmsBaseUrl);
    } catch (error) {
      if ([404, 405].includes(error?.response?.status)) {
        setTimerUnavailable(true);
        return;
      }
      setTimer(null);
    } finally {
      setTimerLoading(false);
    }
  }, [courseId, unitUsageKey, sequenceUsageKey, timerUnavailable]);

  useEffect(() => {
    setTimerUnavailable(false);
    setTimer(null);
    timeoutHandledRef.current = false;
    initialStartDoneRef.current = false;
  }, [courseId, unitUsageKey, sequenceUsageKey]);

  // Synchronize the Paragon theme into the cross-origin LMS XBlock iframe on
  // first load (not only after the user toggles dark/light), and explicitly ask
  // the iframe to report its height after asynchronous problem feedback changes.
  useEffect(() => {
    const boundFrames = new Map();
    const timers = [];
    let stopped = false;
    let queued = null;

    const bindFrame = (frame) => {
      if (!frame || boundFrames.has(frame)) return;
      const onLoad = () => {
        [0, 80, 250, 700].forEach((delay) => {
          const id = window.setTimeout(() => {
            if (!stopped) postIframeUiContract(frame, unitUsageKey, 'iframe-load');
          }, delay);
          timers.push(id);
        });
      };
      frame.addEventListener('load', onLoad);
      boundFrames.set(frame, onLoad);
      postIframeUiContract(frame, unitUsageKey, 'bind');
    };

    const syncAll = (reason) => {
      if (stopped) return;
      getUnitIframes(unitUsageKey).forEach((frame) => {
        bindFrame(frame);
        postIframeUiContract(frame, unitUsageKey, reason);
      });
    };

    const queueSync = (reason) => {
      if (queued) window.clearTimeout(queued);
      queued = window.setTimeout(() => {
        queued = null;
        syncAll(reason);
      }, 40);
    };

    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (record.type === 'attributes') {
          return record.target === document.documentElement || record.target === document.body;
        }
        return Array.from(record.addedNodes || []).some((node) => node?.tagName === 'IFRAME' || node?.querySelector?.('iframe'));
      });
      if (relevant) queueSync('dom-or-theme-change');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-paragon-theme-variant', 'data-bs-theme', 'data-theme'],
      childList: true,
      subtree: true,
    });

    const onStorage = () => queueSync('storage-theme-change');
    const onThemeStylesheetLoad = (event) => {
      if (event?.target?.tagName === 'LINK' && event.target.rel === 'stylesheet') queueSync('theme-stylesheet-load');
    };
    const onVisible = () => { if (document.visibilityState === 'visible') queueSync('visible'); };
    const onMessage = (event) => {
      if (event?.data?.type !== 'AI_QUIZ_IFRAME_READY') return;
      const frame = getUnitIframes(unitUsageKey).find((candidate) => candidate.contentWindow === event.source);
      if (frame) postIframeUiContract(frame, unitUsageKey, 'iframe-ready');
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('load', onThemeStylesheetLoad, true);

    // Paragon may restore the persisted theme after this component mounts. Poll
    // until its html attribute or active stylesheet is available; do not fall
    // back to the operating-system preference because it can disagree with CMS.
    [0, 60, 160, 400, 900, 1800, 3500, 6000].forEach((delay) => {
      timers.push(window.setTimeout(() => syncAll('initial-theme-settle'), delay));
    });

    return () => {
      stopped = true;
      observer.disconnect();
      if (queued) window.clearTimeout(queued);
      timers.forEach((id) => window.clearTimeout(id));
      boundFrames.forEach((onLoad, frame) => frame.removeEventListener('load', onLoad));
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('load', onThemeStylesheetLoad, true);
    };
  }, [unitUsageKey]);

  useEffect(() => { loadTimerStatus({ startIfNeeded: true }); }, [loadTimerStatus]);

  useEffect(() => {
    if (!timer?.timerEnabled || timer.remainingSeconds === null || timer.remainingSeconds === undefined) return undefined;
    const tick = () => setTimer((current) => refreshTimerFromWallClock(current));
    const interval = window.setInterval(tick, 1000);
    const onVisible = () => {
      tick();
      if (document.visibilityState === 'visible') loadTimerStatus();
    };
    const onFocus = () => { tick(); loadTimerStatus(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    tick();
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [timer?.timerEnabled, timer?.expiresAt, timer?.resetAvailableAt, loadTimerStatus]);

  useEffect(() => {
    if (!timer?.timerEnabled || timer.remainingSeconds !== 0 || timeoutHandledRef.current) return;
    if (['EXPIRED', 'LOCKED', 'RESET_WAIT', 'RESET_READY'].includes(timer.status)) return;
    timeoutHandledRef.current = true;

    const handleTimeout = async () => {
      const client = getAuthenticatedHttpClient();
      const lmsBaseUrl = getLmsBaseUrl();
      let submittedProblemCount = 0;
      try { await client.post(`${lmsBaseUrl}/api/unit-reset/v1/quiz-session/timeout`, quizSessionPayload); } catch (error) { /* continue */ }
      if (timer.autoSubmitOnTimeout) {
        submittedProblemCount = await new Promise((resolve) => {
          let resolved = false;
          const done = (event) => {
            if (event?.data?.type !== 'AI_QUIZ_TIMEOUT_API_SUBMIT_DONE') return;
            resolved = true;
            window.removeEventListener('message', done);
            resolve(Number(event.data.submitted_problem_count || 0));
          };
          window.addEventListener('message', done);
          broadcastAutoSubmitToProblemFrames(quizSessionPayload);
          window.setTimeout(() => {
            if (!resolved) {
              window.removeEventListener('message', done);
              resolve(0);
            }
          }, 15000);
        });
      }
      try {
        await client.post(`${lmsBaseUrl}/api/unit-reset/v1/quiz-session/lock`, {
          ...quizSessionPayload,
          submitted_problem_count: submittedProblemCount,
          auto_submit_done: true,
          auto_submit_mode: 'problem_check_api',
        });
      } catch (error) { /* server guard still blocks late submits after grace */ }
      setTimer((current) => current ? {
        ...current,
        status: 'EXPIRED',
        remainingSeconds: 0,
        message: 'Đã hết giờ. Hệ thống đã gửi nộp bài qua API cho các câu bạn đã chọn.',
      } : current);
      await loadTimerStatus();
    };

    handleTimeout();
  }, [timer?.timerEnabled, timer?.remainingSeconds, timer?.status, timer?.autoSubmitOnTimeout, timer?.lockAfterTimeout, courseId, sequenceUsageKey, unitUsageKey, loadTimerStatus]);

  if (!courseId || !unitUsageKey) return null;

  const handleReset = async () => {
    const cooldownSeconds = timer?.cooldownSeconds || 0;
    const cooldownNotice = cooldownSeconds > 0
      ? `\n\nBạn đang trong thời gian chờ. Nếu chưa đủ thời gian, hệ thống sẽ báo còn phải chờ ${formatWaitTime(cooldownSeconds)}.`
      : '';
    const confirmed = window.confirm(`Bạn chắc chắn muốn làm lại bài này? Bài làm hiện tại sẽ bị xóa và hệ thống sẽ random lại bộ câu hỏi mới.${cooldownNotice}`);
    if (!confirmed) return;

    setLoading(true);
    try {
      const client = getAuthenticatedHttpClient();
      const lmsBaseUrl = getLmsBaseUrl();
      const endpoint = timer?.timerEnabled ? `${lmsBaseUrl}/api/unit-reset/v1/quiz-session/reset` : `${lmsBaseUrl}/api/unit-reset/v1/reset/`;
      const response = await client.post(endpoint, quizSessionPayload);
      if (response?.data?.success === true || response?.data?.ok === true) {
        if (timer?.timerEnabled) {
          try {
            const startResponse = await startQuizSession(client, lmsBaseUrl, quizSessionPayload);
            const normalized = normalizeTimerPayload(startResponse?.data);
            setTimer(normalized);
            if (normalized.timerEnabled) loadRuntimeScript(lmsBaseUrl);
            if (hasFreshQuizSession(normalized)) {
              reloadUnitIframeOnce({
                courseId,
                unitUsageKey,
                data: startResponse?.data || response?.data,
                reason: 'quiz-session-reset-start',
              });
            } else {
              window.alert(normalized.message || 'Lượt làm mới chưa sẵn sàng. Vui lòng tải lại trang sau khi hết thời gian chờ.');
              await loadTimerStatus();
            }
            return;
          } catch (startError) {
            // Last-resort fallback: reload the whole MFE if the explicit start endpoint is unavailable.
            window.location.reload();
            return;
          }
        }
        window.location.reload();
        return;
      }
      window.alert(response?.data?.message || 'Không thể làm lại bài.');
    } catch (error) {
      const data = error?.response?.data;
      if (error?.response?.status === 404 && timer?.timerEnabled) {
        try {
          const client = getAuthenticatedHttpClient();
          const lmsBaseUrl = getLmsBaseUrl();
          const response = await client.post(`${lmsBaseUrl}/api/unit-reset/v1/reset/`, quizSessionPayload);
          if (response?.data?.success === true || response?.data?.ok === true) {
            try {
              const startResponse = await startQuizSession(client, lmsBaseUrl, quizSessionPayload);
              const normalized = normalizeTimerPayload(startResponse?.data);
              setTimer(normalized);
              if (normalized.timerEnabled) loadRuntimeScript(lmsBaseUrl);
              if (hasFreshQuizSession(normalized)) {
                reloadUnitIframeOnce({
                  courseId,
                  unitUsageKey,
                  data: startResponse?.data || response?.data,
                  reason: 'quiz-session-reset-fallback-start',
                });
              } else {
                window.alert(normalized.message || 'Lượt làm mới chưa sẵn sàng. Vui lòng tải lại trang sau khi hết thời gian chờ.');
                await loadTimerStatus();
              }
              return;
            } catch (startError) {
              window.location.reload();
              return;
            }
          }
        } catch (fallbackError) { /* continue */ }
      }
      if (data?.code === 'RESET_COOLDOWN' || data?.error_code === 'cooldown_not_expired') {
        const waitSeconds = Number(data?.wait_seconds || data?.remaining_seconds || data?.cooldown_remaining_seconds || 0);
        if (waitSeconds <= 0) {
          window.alert('Đã hết thời gian chờ. Vui lòng bấm Làm lại bài một lần nữa.');
        } else {
          window.alert(`Bạn cần chờ thêm ${formatWaitTime(waitSeconds)} để làm lại bài.`);
        }
        await loadTimerStatus();
        return;
      }
      if (error?.response?.status === 403) {
        window.alert(data?.message || 'Bạn không có quyền làm lại bài này.');
        return;
      }
      if (error?.response?.status === 401) {
        window.alert('Bạn cần đăng nhập để làm lại bài.');
        return;
      }
      window.alert(data?.message || 'Có lỗi hệ thống khi làm lại bài.');
    } finally {
      setLoading(false);
    }
  };

  // Only render the timed quiz panel after the LMS plugin confirms this unit
  // has an active/configured quiz timer. Non-timed videos/html units must not
  // show the reset action, otherwise "Làm lại bài" appears across the course.
  if (timerUnavailable || !timer?.timerEnabled) return null;

  const showTimer = timer.remainingSeconds !== null && timer.remainingSeconds !== undefined;
  const isExpired = showTimer && timer.remainingSeconds <= 0;
  const cooldownSeconds = timer?.cooldownSeconds || 0;
  const isUrgent = showTimer && !isExpired && timer.remainingSeconds <= 60;
  const isCoolingDown = cooldownSeconds > 0;
  const timerStatus = String(timer?.status || '').toUpperCase();
  const isLocked = ['EXPIRED', 'LOCKED', 'RESET_WAIT'].includes(timerStatus) || isExpired;
  const panelTitle = isExpired || isLocked ? 'Đã hết giờ' : 'Thời gian làm bài';
  const panelDescription = isExpired || isLocked
    ? 'Hệ thống đã tự nộp các câu bạn đã chọn và khóa lượt làm này.'
    : isUrgent
      ? 'Sắp hết giờ. Hãy kiểm tra lại đáp án trước khi hệ thống tự nộp.'
      : 'Hệ thống sẽ tự nộp bài khi hết thời gian.';
  const wrapperClassName = [
    'unit-reset-panel',
    isExpired || isLocked ? 'unit-reset-panel--expired' : '',
    isUrgent ? 'unit-reset-panel--urgent' : '',
    isCoolingDown ? 'unit-reset-panel--cooldown' : '',
    timerLoading ? 'unit-reset-panel--syncing' : '',
  ].filter(Boolean).join(' ');
  const statusId = `unit-reset-status-${unitUsageKey || 'unit'}`.replace(/[^a-zA-Z0-9_-]/g, '-');

  return (
    <section
      className={wrapperClassName}
      aria-live="polite"
      aria-describedby={statusId}
      data-timer-status={timerStatus || 'UNKNOWN'}
    >
      <div className="unit-reset-panel__main">
        <div className="unit-reset-panel__icon" aria-hidden="true">
          {isExpired || isLocked ? '!' : '⏱'}
        </div>

        <div className="unit-reset-panel__content">
          <div className="unit-reset-panel__eyebrow">Quiz tự luyện</div>
          <div className="unit-reset-panel__title">{panelTitle}</div>
          <div id={statusId} className="unit-reset-panel__description">
            {panelDescription}
          </div>

          {isCoolingDown && (
            <div className="unit-reset-panel__cooldown">
              Có thể làm lại sau: <strong>{formatWaitTime(cooldownSeconds)}</strong>
            </div>
          )}

          {timerLoading && (
            <div className="unit-reset-panel__sync" role="status" aria-live="polite">
              <span className="spinner-border spinner-border-sm unit-reset-panel__spinner" aria-hidden="true" />
              <span>Đang đồng bộ phiên làm bài...</span>
            </div>
          )}
        </div>
      </div>

      <div className="unit-reset-panel__actions">
        {showTimer && (
          <div className="unit-reset-panel__clock" aria-label={`Thời gian còn lại ${formatClock(timer.remainingSeconds)}`}>
            {formatClock(timer.remainingSeconds)}
          </div>
        )}

        <button
          type="button"
          className="btn btn-outline-primary unit-reset-panel__reset-btn"
          onClick={handleReset}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="spinner-border spinner-border-sm unit-reset-panel__spinner" aria-hidden="true" />
              <span>Đang xử lý...</span>
            </>
          ) : 'Làm lại bài'}
        </button>
      </div>
    </section>
  );
}
