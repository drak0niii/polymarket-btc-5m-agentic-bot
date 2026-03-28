import { useEffect, useState } from 'react';
import {
  apiClient,
  ApiError,
  type PortfolioSnapshotResponse,
} from '../lib/api';

type PortfolioFetchStatus = 'loading' | 'ready' | 'missing' | 'stale' | 'error';

function describeApiError(error: unknown) {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Portfolio request failed.';
}

export function usePortfolio() {
  const [portfolio, setPortfolio] = useState<PortfolioSnapshotResponse | null>(null);
  const [status, setStatus] = useState<PortfolioFetchStatus>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const nextPortfolio = await apiClient.getPortfolio();
        if (!active) return;
        setPortfolio(nextPortfolio.snapshot);
        setMessage(nextPortfolio.message);
        setStatus(nextPortfolio.status === 'ready' ? 'ready' : 'missing');
        setLastSuccessfulSyncAt(new Date().toISOString());
      } catch (error) {
        if (!active) return;
        setMessage(describeApiError(error));
        setStatus((current) =>
          current === 'ready' || current === 'missing' ? 'stale' : 'error',
        );
      }
    };

    void load();

    const interval = window.setInterval(() => {
      void load();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return {
    portfolio,
    status,
    message,
    lastSuccessfulSyncAt,
  };
}
