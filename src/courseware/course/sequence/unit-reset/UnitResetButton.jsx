import React, { useState } from 'react';
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
  const total = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;

  if (minutes <= 0) {
    return `${secs} giây`;
  }

  return `${minutes} phút ${secs} giây`;
}

export default function UnitResetButton({ courseId, unitUsageKey }) {
  const [loading, setLoading] = useState(false);

  if (!courseId || !unitUsageKey) {
    return null;
  }

  const handleReset = async () => {
    const confirmed = window.confirm(
      'Bạn chắc chắn muốn làm lại bài này? Bài làm hiện tại sẽ bị xóa và hệ thống sẽ random lại bộ câu hỏi mới.',
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
        const waitSeconds = data?.wait_seconds || data?.remaining_seconds || 0;
        window.alert(`Bạn cần chờ thêm ${formatWaitTime(waitSeconds)} để làm lại bài.`);
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

  return (
    <div className="unit-reset-wrapper my-3">
      <button
        type="button"
        className="btn btn-outline-primary"
        onClick={handleReset}
        disabled={loading}
      >
        {loading ? 'Đang xử lý...' : 'Làm lại bài'}
      </button>
    </div>
  );
}