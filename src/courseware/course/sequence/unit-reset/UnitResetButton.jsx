import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthenticatedHttpClient } from '@edx/frontend-platform/auth';
import { getConfig } from '@edx/frontend-platform';

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
    || rawRemaining !== null,
  );
  return {
    timerEnabled,
    status,
    remainingSeconds: rawRemaining === null || rawRemaining === undefined ? null : Math.max(0, Math.floor(Number(rawRemaining || 0))),
    cooldownSeconds: rawCooldown === null || rawCooldown === undefined ? 0 : Math.max(0, Math.floor(Number(rawCooldown || 0))),
    autoSubmitOnTimeout: data?.auto_submit_on_timeout ?? config?.auto_submit_on_timeout ?? true,
    lockAfterTimeout: data?.lock_after_timeout ?? config?.lock_after_timeout ?? true,
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

function reloadUnitIframeOnce({ courseId, unitUsageKey, data, reason }) {
  const iframe = document.getElementById('unit-iframe');
  const token = getTimerSessionToken(data);
  const storageKey = `openedx-unit-reset:iframe-reloaded:${courseId}:${unitUsageKey}:${reason}:${token}`;

  try {
    if (window.sessionStorage.getItem(storageKey) === '1') return false;
    window.sessionStorage.setItem(storageKey, '1');
  } catch (error) {
    // sessionStorage can be unavailable in strict browser modes. Reloading the iframe is still safe.
  }

  if (!iframe) {
    window.location.reload();
    return true;
  }

  const rawSrc = iframe.getAttribute('src') || iframe.src;
  if (!rawSrc) {
    window.location.reload();
    return true;
  }

  const url = new URL(rawSrc, window.location.href);
  url.searchParams.set('unit_reset_nonce', String(Date.now()));
  url.searchParams.set('unit_reset_reason', reason);
  iframe.src = url.toString();
  return true;
}

async function startQuizSession(client, lmsBaseUrl, quizSessionPayload) {
  return client.post(`${lmsBaseUrl}/api/unit-reset/v1/quiz-session/start`, quizSessionPayload);
}

function broadcastAutoSubmitToProblemFrames(lmsBaseUrl) {
  const message = { type: 'AI_QUIZ_TIMEOUT_AUTO_SUBMIT' };
  const lmsOrigin = (() => {
    try { return new URL(lmsBaseUrl).origin; } catch (error) { return window.location.origin; }
  })();
  window.postMessage(message, window.location.origin);
  Array.from(document.querySelectorAll('iframe')).forEach((frame) => {
    try { frame.contentWindow?.postMessage(message, lmsOrigin); } catch (error) { /* ignore cross-origin frame access */ }
  });
}

export default function UnitResetButton({ courseId, sequenceUsageKey, unitUsageKey }) {
  const [loading, setLoading] = useState(false);
  const [timerLoading, setTimerLoading] = useState(false);
  const [timerUnavailable, setTimerUnavailable] = useState(false);
  const [timer, setTimer] = useState(null);
  const timeoutHandledRef = useRef(false);

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
            // The LMS unit iframe may render before the ACTIVE quiz session exists.
            // Reload it once after a successful start so CAPA/problem JS initializes against fresh state.
            reloadUnitIframeOnce({
              courseId,
              unitUsageKey,
              data: startResponse?.data,
              reason: 'quiz-session-start',
            });
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
  }, [courseId, unitUsageKey, sequenceUsageKey]);

  useEffect(() => { loadTimerStatus({ startIfNeeded: true }); }, [loadTimerStatus]);

  useEffect(() => {
    if (!timer?.timerEnabled || timer.remainingSeconds === null || timer.remainingSeconds === undefined) return undefined;
    const interval = window.setInterval(() => {
      setTimer((current) => {
        if (!current || current.remainingSeconds === null || current.remainingSeconds === undefined) return current;
        return {
          ...current,
          remainingSeconds: Math.max(0, current.remainingSeconds - 1),
          cooldownSeconds: Math.max(0, current.cooldownSeconds - 1),
        };
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [timer?.timerEnabled, timer?.remainingSeconds]);

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
            if (event?.data?.type !== 'AI_QUIZ_TIMEOUT_AUTO_SUBMIT_DONE') return;
            resolved = true;
            window.removeEventListener('message', done);
            resolve(Number(event.data.submitted_problem_count || 0));
          };
          window.addEventListener('message', done);
          broadcastAutoSubmitToProblemFrames(lmsBaseUrl);
          window.setTimeout(() => {
            if (!resolved) {
              window.removeEventListener('message', done);
              resolve(0);
            }
          }, 8000);
        });
      }
      if (timer.lockAfterTimeout) {
        try {
          await client.post(`${lmsBaseUrl}/api/unit-reset/v1/quiz-session/lock`, {
            ...quizSessionPayload,
            submitted_problem_count: submittedProblemCount,
            auto_submit_done: true,
          });
        } catch (error) { /* server guard still blocks late submits */ }
      }
      setTimer((current) => current ? {
        ...current,
        status: 'EXPIRED',
        remainingSeconds: 0,
        message: 'Đã hết giờ. Hệ thống đã tự nộp các câu bạn đã chọn và khóa lượt làm này.',
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
            reloadUnitIframeOnce({
              courseId,
              unitUsageKey,
              data: startResponse?.data || response?.data,
              reason: 'quiz-session-reset-start',
            });
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
              reloadUnitIframeOnce({
                courseId,
                unitUsageKey,
                data: startResponse?.data || response?.data,
                reason: 'quiz-session-reset-fallback-start',
              });
              return;
            } catch (startError) {
              window.location.reload();
              return;
            }
          }
        } catch (fallbackError) { /* continue */ }
      }
      if (data?.code === 'RESET_COOLDOWN' || data?.error_code === 'cooldown_not_expired') {
        const waitSeconds = data?.wait_seconds || data?.remaining_seconds || data?.cooldown_remaining_seconds || 0;
        window.alert(`Bạn cần chờ thêm ${formatWaitTime(waitSeconds)} để làm lại bài.`);
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

  const showTimer = timer?.timerEnabled && timer.remainingSeconds !== null && timer.remainingSeconds !== undefined;
  const isExpired = showTimer && timer.remainingSeconds <= 0;
  const cooldownSeconds = timer?.cooldownSeconds || 0;

  return (
    <div className="unit-reset-wrapper my-3 p-3 border rounded bg-light">
      {showTimer && (
        <div className="d-flex flex-wrap align-items-center justify-content-between mb-3">
          <div>
            <div className="small text-muted">Quiz tự luyện</div>
            <div className="font-weight-bold">{isExpired ? 'Đã hết giờ' : 'Thời gian còn lại'}</div>
          </div>
          <div className={`h4 mb-0 ${isExpired ? 'text-danger' : 'text-primary'}`}>{formatClock(timer.remainingSeconds)}</div>
        </div>
      )}
      {showTimer && isExpired && (
        <div className="alert alert-warning py-2 mb-3">Đã hết giờ. Hệ thống đã tự nộp các câu bạn đã chọn và khóa lượt làm này.</div>
      )}
      {cooldownSeconds > 0 && (
        <div className="small text-muted mb-2">Bạn có thể làm lại sau: <strong>{formatWaitTime(cooldownSeconds)}</strong></div>
      )}
      <button type="button" className="btn btn-outline-primary" onClick={handleReset} disabled={loading}>
        {loading ? 'Đang xử lý...' : 'Làm lại bài'}
      </button>
      {timerLoading && <span className="small text-muted ml-2">Đang tải thời gian...</span>}
    </div>
  );
}
