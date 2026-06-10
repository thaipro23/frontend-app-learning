import React, { useCallback, useEffect, useState } from 'react';
import { getAuthenticatedHttpClient } from '@edx/frontend-platform/auth';
import { getConfig } from '@edx/frontend-platform';

function getLmsBaseUrl() {
  const config = getConfig();

  return (
    config.LMS_BASE_URL
    || config.LMS_BASE_URL_LEGACY
    || window.location.origin.replace('apps.', '')
  );
}

function formatWaitTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours} giờ ${minutes} phút ${secs} giây`;
  }

  if (minutes <= 0) {
    return `${secs} giây`;
  }

  return `${minutes} phút ${secs} giây`;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }

  return `${mm}:${ss}`;
}

function secondsUntil(dateString) {
  if (!dateString) {
    return null;
  }

  const target = new Date(dateString).getTime();

  if (Number.isNaN(target)) {
    return null;
  }

  return Math.max(0, Math.floor((target - Date.now()) / 1000));
}

function normalizeTimerPayload(data) {
  const session = data?.session || data?.quiz_session || {};
  const rawRemaining = data?.remaining_seconds
    ?? data?.time_remaining_seconds
    ?? data?.remaining_time_seconds
    ?? session?.remaining_seconds
    ?? session?.time_remaining_seconds
    ?? secondsUntil(data?.expires_at || session?.expires_at);
  const rawCooldown = data?.cooldown_remaining_seconds
    ?? data?.reset_remaining_seconds
    ?? data?.remaining_cooldown_seconds
    ?? data?.wait_seconds
    ?? session?.cooldown_remaining_seconds
    ?? session?.reset_remaining_seconds
    ?? secondsUntil(data?.reset_available_at || session?.reset_available_at);
  const expiresAt = data?.expires_at || session?.expires_at || null;
  const status = String(data?.status || session?.status || '').toUpperCase();
  const timerEnabled = Boolean(
    data?.timer_enabled
    || data?.custom_timer_enabled
    || data?.enabled
    || data?.configured
    || expiresAt
    || rawRemaining !== null,
  );

  return {
    timerEnabled,
    status,
    remainingSeconds: rawRemaining === null || rawRemaining === undefined ? null : Math.max(0, Math.floor(Number(rawRemaining || 0))),
    cooldownSeconds: rawCooldown === null || rawCooldown === undefined ? 0 : Math.max(0, Math.floor(Number(rawCooldown || 0))),
    expiresAt,
    message: data?.message || session?.message || '',
  };
}

export default function UnitResetButton({ courseId, sequenceUsageKey, unitUsageKey }) {
  const [loading, setLoading] = useState(false);
  const [timerLoading, setTimerLoading] = useState(false);
  const [timerUnavailable, setTimerUnavailable] = useState(false);
  const [timer, setTimer] = useState(null);

  const quizSessionPayload = {
    course_id: courseId,
    sequence_usage_key: sequenceUsageKey,
    unit_usage_key: unitUsageKey,
  };

  const loadTimerStatus = useCallback(async ({ startIfNeeded = false } = {}) => {
    if (!courseId || !unitUsageKey || timerUnavailable) {
      return;
    }

    const client = getAuthenticatedHttpClient();
    const lmsBaseUrl = getLmsBaseUrl();

    try {
      setTimerLoading(true);

      if (startIfNeeded) {
        try {
          const startResponse = await client.post(
            `${lmsBaseUrl}/api/unit-reset/v1/quiz-session/start`,
            quizSessionPayload,
          );

          setTimer(normalizeTimerPayload(startResponse?.data));
          return;
        } catch (startError) {
          if (![404, 405].includes(startError?.response?.status)) {
            throw startError;
          }
        }
      }

      const response = await client.get(
        `${lmsBaseUrl}/api/unit-reset/v1/quiz-session/status`,
        { params: quizSessionPayload },
      );

      setTimer(normalizeTimerPayload(response?.data));
    } catch (error) {
      if ([404, 405].includes(error?.response?.status)) {
        setTimerUnavailable(true);
        return;
      }

      // Timer is additive. Do not hide the existing reset button if the timer API fails.
      setTimer(null);
    } finally {
      setTimerLoading(false);
    }
  }, [courseId, unitUsageKey, sequenceUsageKey, timerUnavailable]);

  useEffect(() => {
    setTimerUnavailable(false);
    setTimer(null);
  }, [courseId, unitUsageKey, sequenceUsageKey]);

  useEffect(() => {
    loadTimerStatus({ startIfNeeded: true });
  }, [loadTimerStatus]);

  useEffect(() => {
    if (!timer?.timerEnabled || timer.remainingSeconds === null || timer.remainingSeconds === undefined) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setTimer((current) => {
        if (!current || current.remainingSeconds === null || current.remainingSeconds === undefined) {
          return current;
        }

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
    if (!timer?.timerEnabled || timer.remainingSeconds !== 0) {
      return;
    }

    if (['EXPIRED', 'LOCKED', 'SUBMITTING'].includes(timer.status)) {
      return;
    }

    const markTimeout = async () => {
      try {
        const client = getAuthenticatedHttpClient();
        const lmsBaseUrl = getLmsBaseUrl();

        await client.post(
          `${lmsBaseUrl}/api/unit-reset/v1/quiz-session/timeout`,
          quizSessionPayload,
        );

        setTimer((current) => current ? { ...current, status: 'EXPIRED', message: 'Đã hết giờ làm bài.' } : current);
      } catch (error) {
        setTimer((current) => current ? { ...current, status: 'EXPIRED' } : current);
      }
    };

    markTimeout();
  }, [timer?.timerEnabled, timer?.remainingSeconds, timer?.status, courseId, sequenceUsageKey, unitUsageKey]);

  if (!courseId || !unitUsageKey) {
    return null;
  }

  const handleReset = async () => {
    const cooldownSeconds = timer?.cooldownSeconds || 0;
    const cooldownNotice = cooldownSeconds > 0
      ? `\n\nBạn đang trong thời gian chờ. Nếu chưa đủ thời gian, hệ thống sẽ báo còn phải chờ ${formatWaitTime(cooldownSeconds)}.`
      : '';
    const confirmed = window.confirm(
      `Bạn chắc chắn muốn làm lại bài này? Bài làm hiện tại sẽ bị xóa và hệ thống sẽ random lại bộ câu hỏi mới.${cooldownNotice}`,
    );

    if (!confirmed) {
      return;
    }

    setLoading(true);

    try {
      const client = getAuthenticatedHttpClient();
      const lmsBaseUrl = getLmsBaseUrl();

      const response = await client.post(
        `${lmsBaseUrl}/api/unit-reset/v1/reset/`,
        {
          course_id: courseId,
          sequence_usage_key: sequenceUsageKey,
          unit_usage_key: unitUsageKey,
        },
      );

      if (response?.data?.success === true || response?.data?.ok === true) {
        window.location.reload();
        return;
      }

      window.alert(response?.data?.message || 'Không thể làm lại bài.');
    } catch (error) {
      const data = error?.response?.data;

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
            <div className="font-weight-bold">
              {isExpired ? 'Đã hết giờ' : 'Thời gian còn lại'}
            </div>
          </div>
          <div className={`h4 mb-0 ${isExpired ? 'text-danger' : 'text-primary'}`}>
            {formatClock(timer.remainingSeconds)}
          </div>
        </div>
      )}

      {showTimer && isExpired && (
        <div className="alert alert-warning py-2 mb-3">
          Đã hết giờ. Hệ thống sẽ khóa lượt làm theo cấu hình của quiz.
        </div>
      )}

      {cooldownSeconds > 0 && (
        <div className="small text-muted mb-2">
          Bạn có thể làm lại sau: <strong>{formatWaitTime(cooldownSeconds)}</strong>
        </div>
      )}

      <button
        type="button"
        className="btn btn-outline-primary"
        onClick={handleReset}
        disabled={loading}
      >
        {loading ? 'Đang xử lý...' : 'Làm lại bài'}
      </button>

      {timerLoading && (
        <span className="small text-muted ml-2">Đang tải thời gian...</span>
      )}
    </div>
  );
}

UnitResetButton.defaultProps = {
  sequenceUsageKey: null,
};
