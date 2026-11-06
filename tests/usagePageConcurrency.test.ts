import { describe, expect, test } from 'bun:test';
import {
  createLatestUsageRequestGuard,
  fetchUsagePageSources,
  runLatestUsageRequest,
} from '../src/pages/usage-page-request-guard';
import { supportsLegacyUsage } from '../src/services/api/usage';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('UsagePage request sources', () => {
  test('skips the removed legacy usage endpoint on v8', () => {
    expect(supportsLegacyUsage('v8.0.57')).toBe(false);
    expect(supportsLegacyUsage('8.0.0')).toBe(false);
    expect(supportsLegacyUsage('v7.2.1')).toBe(true);
    expect(supportsLegacyUsage(null)).toBe(true);
  });

  test('fetches the separate flag endpoint instead of relying on a flag in the usage payload', async () => {
    let flagCalls = 0;
    let usageCalls = 0;
    const result = await fetchUsagePageSources({
      getStatisticsEnabled: async () => {
        flagCalls += 1;
        return false;
      },
      getUsage: async () => {
        usageCalls += 1;
        return { statistics_enabled: true, usage: { total_requests: 9 } };
      },
    });
    expect(flagCalls).toBe(1);
    expect(usageCalls).toBe(1);
    expect(result.enabled).toEqual({ status: 'fulfilled', value: false });
    expect(result.payload).toMatchObject({ status: 'fulfilled' });
  });

  test('preserves known disabled and unknown flags when the snapshot fetch fails', async () => {
    for (const flag of [false, null]) {
      const result = await fetchUsagePageSources({
        getStatisticsEnabled: async () => flag,
        getUsage: async () => {
          throw new Error('snapshot failed');
        },
      });
      expect(result.enabled).toEqual({ status: 'fulfilled', value: flag });
      expect(result.payload.status).toBe('rejected');
    }
  });

  test('treats a missing usage snapshot as a failed fetch, never an empty success', async () => {
    const result = await fetchUsagePageSources({
      getStatisticsEnabled: async () => true,
      getUsage: async () => ({}),
    });
    expect(result.payload.status).toBe('rejected');
  });

  test('treats the removed v8 usage endpoint as a disabled snapshot', async () => {
    const result = await fetchUsagePageSources({
      getStatisticsEnabled: async () => true,
      getUsage: async () => ({ statistics_enabled: false }),
    });
    expect(result.payload).toEqual({
      status: 'fulfilled',
      value: { statistics_enabled: false },
    });
  });

  test('does not turn a flag request failure into unsupported status', async () => {
    const result = await fetchUsagePageSources({
      getStatisticsEnabled: async () => {
        throw new Error('flag failed');
      },
      getUsage: async () => ({ usage: { total_requests: 10 } }),
    });
    expect(result.enabled.status).toBe('rejected');
    expect(result.payload.status).toBe('fulfilled');
  });
});

describe('UsagePage request ordering', () => {
  test('only the newest concurrent request may commit state or clear loading', () => {
    const guard = createLatestUsageRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isLatest(first)).toBe(false);
    expect(guard.isLatest(second)).toBe(true);
  });

  test('invalidates an in-flight request when the page unmounts', () => {
    const guard = createLatestUsageRequestGuard();
    const request = guard.begin();

    guard.invalidate();

    expect(guard.isLatest(request)).toBe(false);
  });

  test('a stale failure is not eligible for propagation after a newer success', () => {
    const guard = createLatestUsageRequestGuard();
    const staleFailure = guard.begin();
    const newerSuccess = guard.begin();

    expect(guard.isLatest(newerSuccess)).toBe(true);
    expect(guard.isLatest(staleFailure)).toBe(false);
  });

  test('newer success suppresses an older failure across the page request orchestration', async () => {
    const guard = createLatestUsageRequestGuard();
    const first = deferred<string>();
    const second = deferred<string>();
    const successes: string[] = [];
    const errors: string[] = [];
    let finishes = 0;
    const run = (request: () => Promise<string>) =>
      runLatestUsageRequest({
        guard,
        request,
        fallbackError: 'load failed',
        onStart: () => undefined,
        onSuccess: (payload) => successes.push(payload),
        onError: (message) => errors.push(message),
        onFinish: () => {
          finishes += 1;
        },
      });

    const staleRun = run(() => first.promise);
    const latestRun = run(() => second.promise);
    second.resolve('latest');
    await latestRun;
    first.reject(new Error('stale failure'));

    await expect(staleRun).resolves.toBeUndefined();
    expect(successes).toEqual(['latest']);
    expect(errors).toEqual([]);
    expect(finishes).toBe(1);
  });

  test('a changed backend, credential, authentication or connection invalidates both source results', async () => {
    const initial = {
      apiBase: 'https://old.invalid',
      managementKey: 'fixture-old-key',
      isAuthenticated: true,
      connectionStatus: 'connected',
    };
    for (const changed of [
      { apiBase: 'https://new.invalid' },
      { managementKey: 'fixture-new-key' },
      { isAuthenticated: false },
      { connectionStatus: 'connecting' },
    ]) {
      let session = initial;
      const guard = createLatestUsageRequestGuard(() => session);
      const response = deferred<string>();
      const committed: string[] = [];
      const run = runLatestUsageRequest({
        guard,
        request: () => response.promise,
        fallbackError: 'failed',
        onStart: () => undefined,
        onSuccess: (value) => committed.push(value),
        onError: (message) => committed.push(message),
        onFinish: () => committed.push('finished'),
      });
      session = { ...initial, ...changed };
      response.resolve('old snapshot and flag');
      await run;
      expect(committed).toEqual([]);
    }
  });

  test('invalidating the session suppresses an old failure without propagating it', async () => {
    let session = {
      apiBase: 'https://old.invalid',
      managementKey: 'fixture-key',
      isAuthenticated: true,
      connectionStatus: 'connected',
    };
    const response = deferred<string>();
    const errors: string[] = [];
    const run = runLatestUsageRequest({
      guard: createLatestUsageRequestGuard(() => session),
      request: () => response.promise,
      fallbackError: 'failed',
      onStart: () => undefined,
      onSuccess: () => errors.push('success'),
      onError: (message) => errors.push(message),
      onFinish: () => errors.push('finished'),
    });
    session = { ...session, isAuthenticated: false };
    response.reject(new Error('old session failed'));
    await expect(run).resolves.toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('partial source failures commit their known flag and reject the global refresh', async () => {
    const events: string[] = [];
    const run = runLatestUsageRequest({
      guard: createLatestUsageRequestGuard(),
      request: () =>
        fetchUsagePageSources({
          getStatisticsEnabled: async () => false,
          getUsage: async () => {
            throw new Error('failed');
          },
        }),
      fallbackError: 'failed',
      getResultError: (result) =>
        result.payload.status === 'rejected' ? 'Snapshot fetch failed' : null,
      onStart: () => undefined,
      onSuccess: (result) => {
        if (result.enabled.status === 'fulfilled') events.push(String(result.enabled.value));
      },
      onError: (message) => events.push(message),
      onFinish: () => events.push('finished'),
    });
    await expect(run).rejects.toThrow('Snapshot fetch failed');
    expect(events).toEqual(['false', 'Snapshot fetch failed', 'finished']);
  });

  test('current failure renders its message and rejects to the global refresh caller', async () => {
    const errors: string[] = [];
    let finishes = 0;
    const failure = runLatestUsageRequest({
      guard: createLatestUsageRequestGuard(),
      request: () => Promise.reject(new Error('current failure')),
      fallbackError: 'load failed',
      onStart: () => undefined,
      onSuccess: () => undefined,
      onError: (message) => errors.push(message),
      onFinish: () => {
        finishes += 1;
      },
    });

    await expect(failure).rejects.toThrow('current failure');
    expect(errors).toEqual(['current failure']);
    expect(finishes).toBe(1);
  });
});
