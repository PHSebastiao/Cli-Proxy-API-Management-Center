import type { UsageResponse } from '@/types/usage';

interface UsagePageSession {
  apiBase: string;
  managementKey: string;
  isAuthenticated: boolean;
  connectionStatus: string;
}

export const usageSessionRequestState = (
  session: Pick<UsagePageSession, 'isAuthenticated' | 'connectionStatus'>
): 'connecting' | 'ready' | 'stopped' => {
  if (session.connectionStatus === 'connecting') return 'connecting';
  return session.isAuthenticated && session.connectionStatus === 'connected' ? 'ready' : 'stopped';
};

export const sameUsageSession = (a: UsagePageSession, b: UsagePageSession): boolean =>
  a.apiBase === b.apiBase &&
  a.managementKey === b.managementKey &&
  a.isAuthenticated === b.isAuthenticated &&
  a.connectionStatus === b.connectionStatus;

export const createLatestUsageRequestGuard = (getSession?: () => UsagePageSession) => {
  let latestRequestId = 0;
  let session = getSession?.();

  return {
    begin: () => {
      session = getSession?.();
      return ++latestRequestId;
    },
    isLatest: (requestId: number) =>
      requestId === latestRequestId &&
      (!getSession || (session !== undefined && sameUsageSession(session, getSession()))),
    invalidate: () => {
      latestRequestId += 1;
    },
  };
};

export interface UsagePageSources {
  enabled: PromiseSettledResult<boolean | null>;
  payload: PromiseSettledResult<UsageResponse>;
}

export const fetchUsagePageSources = async (api: {
  getStatisticsEnabled: () => Promise<boolean | null>;
  getUsage: () => Promise<UsageResponse>;
}): Promise<UsagePageSources> => {
  const [enabled, payload] = await Promise.allSettled([
    api.getStatisticsEnabled(),
    api.getUsage().then((response) => {
      if (response.statistics_enabled === false) return response;
      if (!response.usage) throw new Error('Usage snapshot missing');
      return response;
    }),
  ]);
  return { enabled, payload };
};

export interface LatestUsageRequestOptions<T> {
  guard: ReturnType<typeof createLatestUsageRequestGuard>;
  request: () => Promise<T>;
  fallbackError: string;
  getResultError?: (payload: T) => string | null;
  onStart: () => void;
  onSuccess: (payload: T) => void;
  onError: (message: string) => void;
  onFinish: () => void;
}

export const runLatestUsageRequest = async <T>({
  guard,
  request,
  fallbackError,
  getResultError,
  onStart,
  onSuccess,
  onError,
  onFinish,
}: LatestUsageRequestOptions<T>): Promise<void> => {
  const requestId = guard.begin();
  onStart();

  try {
    const payload = await request();
    if (!guard.isLatest(requestId)) return;
    onSuccess(payload);
    const resultError = getResultError?.(payload);
    if (resultError) throw new Error(resultError);
  } catch (error) {
    if (!guard.isLatest(requestId)) return;
    const message = error instanceof Error ? error.message : String(error);
    const normalizedError = error instanceof Error ? error : new Error(message || fallbackError);
    onError(message || fallbackError);
    throw normalizedError;
  } finally {
    if (guard.isLatest(requestId)) onFinish();
  }
};
