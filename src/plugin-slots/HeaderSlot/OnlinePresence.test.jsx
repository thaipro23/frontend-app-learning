import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

import OnlinePresence, { formatOnlineCount } from './OnlinePresence';

jest.mock('@edx/frontend-platform', () => ({
  getConfig: () => ({ LMS_BASE_URL: 'https://cms.fpl.edu.vn' }),
}));

describe('OnlinePresence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('formats online users with vi-VN thousands separators', () => {
    expect(formatOnlineCount(1284)).toBe('1.284');
  });

  it('renders the compact online label from the presence API', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ active: 1284, window_minutes: 10 }),
    });

    render(<OnlinePresence />);

    expect(await screen.findByText('🟢 1.284 online')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://cms.fpl.edu.vn/api/presence/v1/count',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('refreshes the count every 60 seconds', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ active: 10, window_minutes: 10 }),
    });

    render(<OnlinePresence />);
    expect(await screen.findByText('🟢 10 online')).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  });

  it('hides the indicator when the API is unavailable', async () => {
    global.fetch.mockRejectedValue(new Error('presence unavailable'));

    const { container } = render(<OnlinePresence />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });
});
