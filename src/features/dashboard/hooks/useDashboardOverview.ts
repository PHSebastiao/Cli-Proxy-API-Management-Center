import { useCallback, useEffect, useMemo } from 'react';
import { publishAuthFilesCount } from '@/features/authFiles/authFilesEvents';
import { useTranslation } from 'react-i18next';
import {
  apiKeyUsageApi,
  authFilesApi,
  modelsApi,
  supportsLegacyUsage,
  usageApi,
} from '@/services/api';
import { useAuthStore, useConfigStore } from '@/stores';
import { useApiKeysForModels } from '@/hooks/useApiKeysForModels';
import type { Config } from '@/types';
import type { UsageSnapshot } from '@/types/usage';
import { parseTimestampMs } from '@/utils/timestamp';
import type { DashboardCounts } from '../types';
import type { DashboardSourceId } from '../logic/attention';
import { buildFleetModel } from '../logic/fleet';
import type { SourceStatus } from '../logic/freshness';
import { usePolledResource, type PolledResource } from './usePolledResource';

/** Polling cadence per source while the dashboard is visible. */
export const DASHBOARD_POLL_MS: Record<DashboardSourceId, number> = {
  credentials: 15_000,
  traffic: 15_000,
  config: 15_000,
  /** The advertised model list rarely changes; its stamp states the slower cadence. */
  models: 60_000,
  usage: 15_000,
};

/** Upper bound per attempt, so a stalled request surfaces as a failure instead of hanging. */
const DASHBOARD_TIMEOUT_MS: Record<DashboardSourceId, number> = {
  credentials: 20_000,
  traffic: 20_000,
  config: 20_000,
  models: 15_000,
  usage: 75_000,
};

export const DASHBOARD_SOURCE_IDS: DashboardSourceId[] = [
  'credentials',
  'traffic',
  'config',
  'models',
  'usage',
];

export interface UsageSourceData {
  /** null when the backend does not expose usage statistics at all. */
  enabled: boolean | null;
  usage: UsageSnapshot | null;
}

export const getProviderKeyCounts = (config: Config) => ({
  gemini: config.geminiApiKeys?.length ?? 0,
  interactions: config.interactionsApiKeys?.length ?? 0,
  codex: config.codexApiKeys?.length ?? 0,
  meta: config.metaApiKeys?.length ?? 0,
  xai: config.xaiApiKeys?.length ?? 0,
  claude: config.claudeApiKeys?.length ?? 0,
  vertex: config.vertexApiKeys?.length ?? 0,
  openai: config.openaiCompatibility?.length ?? 0,
});

const statusOf = <T>(resource: PolledResource<T>): SourceStatus => ({
  receivedAt: resource.receivedAt,
  error: resource.error,
  loading: resource.loading,
});

/**
 * Everything the dashboard shows, kept current by polling.
 *
 * Credentials, API-key traffic, configuration, and usage statistics refresh every 15
 * seconds; the model list every minute. Each source reports its own receipt time and
 * error so the page can say how old every number is.
 */
export function useDashboardOverview() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const storeConfig = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const resolveApiKeysForModels = useApiKeysForModels();

  const connected = connectionStatus === 'connected';
  const scope = `${apiBase}\u0000${managementKey}`;

  const credentialsResource = usePolledResource({
    scope,
    enabled: connected,
    intervalMs: DASHBOARD_POLL_MS.credentials,
    timeoutMs: DASHBOARD_TIMEOUT_MS.credentials,
    load: () => authFilesApi.list(),
  });

  const trafficResource = usePolledResource({
    scope,
    enabled: connected,
    intervalMs: DASHBOARD_POLL_MS.traffic,
    timeoutMs: DASHBOARD_TIMEOUT_MS.traffic,
    load: () => apiKeyUsageApi.getUsage(),
  });

  const configResource = usePolledResource({
    scope,
    enabled: connected,
    intervalMs: DASHBOARD_POLL_MS.config,
    timeoutMs: DASHBOARD_TIMEOUT_MS.config,
    load: () => fetchConfig(true),
  });

  // Fetched directly rather than through the shared models store, so a request that
  // outlives its session can only reach this scoped resource, which discards it.
  const modelsResource = usePolledResource({
    scope,
    enabled: connected && Boolean(apiBase),
    intervalMs: DASHBOARD_POLL_MS.models,
    timeoutMs: DASHBOARD_TIMEOUT_MS.models,
    load: async (signal) => {
      const apiKeys = await resolveApiKeysForModels();
      if (signal.aborted) throw new Error('Request aborted');
      return modelsApi.fetchModels(
        apiBase,
        apiKeys[0],
        {},
        {
          signal,
          timeout: DASHBOARD_TIMEOUT_MS.models,
        }
      );
    },
  });

  const usageResource = usePolledResource<UsageSourceData>({
    scope,
    enabled: connected && supportsLegacyUsage(serverVersion),
    intervalMs: DASHBOARD_POLL_MS.usage,
    timeoutMs: DASHBOARD_TIMEOUT_MS.usage,
    load: async () => {
      const enabled = await usageApi.getStatisticsEnabled();
      if (enabled !== true) return { enabled, usage: null };
      const response = await usageApi.getUsage();
      return {
        enabled: response?.statistics_enabled ?? enabled,
        usage: response?.usage ?? null,
      };
    },
  });

  // Keep the sidebar's Auth Files badge in step with what the dashboard shows. While the
  // credentials source is failing, the count is unknown rather than last-known.
  const credentialFileCount = credentialsResource.data?.files.length ?? null;
  const credentialsFailing = credentialsResource.error !== null;
  useEffect(() => {
    if (!connected) return;
    if (credentialsFailing) publishAuthFilesCount(null);
    else if (credentialFileCount !== null) publishAuthFilesCount(credentialFileCount);
  }, [connected, credentialFileCount, credentialsFailing]);

  const resources = useMemo(
    () => ({
      credentials: credentialsResource,
      traffic: trafficResource,
      config: configResource,
      models: modelsResource,
      usage: usageResource,
    }),
    [credentialsResource, trafficResource, configResource, modelsResource, usageResource]
  );

  const fleet = useMemo(
    () =>
      buildFleetModel({
        authFiles: credentialsResource.data?.files ?? null,
        observedAtMs: (() => {
          const parsed = parseTimestampMs(credentialsResource.data?.observedAt);
          return Number.isFinite(parsed) ? parsed : null;
        })(),
        authFilesReceivedAt: credentialsResource.receivedAt,
        keyUsage: trafficResource.data,
        keyUsageReceivedAt: trafficResource.receivedAt,
      }),
    [
      credentialsResource.data,
      credentialsResource.receivedAt,
      trafficResource.data,
      trafficResource.receivedAt,
    ]
  );

  // The header "Refresh all" clears the shared config store before reloading. Fall back to
  // this page's last good snapshot so a failed reload does not blank the runtime panel.
  const config = storeConfig ?? configResource.data;

  const counts = useMemo<DashboardCounts>(() => {
    const providerKeyCounts = config ? getProviderKeyCounts(config) : null;
    return {
      clientApiKeys: config ? (config.apiKeys?.length ?? 0) : null,
      providerKeys: providerKeyCounts
        ? Object.values(providerKeyCounts).reduce((sum, count) => sum + count, 0)
        : null,
      credentials: fleet.credentials ? fleet.credentials.total : null,
      models: modelsResource.data ? modelsResource.data.length : null,
    };
  }, [config, fleet.credentials, modelsResource.data]);

  const sources = useMemo(
    () =>
      Object.fromEntries(
        DASHBOARD_SOURCE_IDS.map((id) => [id, statusOf(resources[id] as PolledResource<unknown>)])
      ) as Record<DashboardSourceId, SourceStatus>,
    [resources]
  );

  // Credentials and traffic feed one headline: a Retry of either refreshes both and ends
  // when both have answered, so they stay in step and the Retry's announcement covers the
  // whole headline. The result (success or failure) is the requested source's.
  const retrySource = useCallback(
    async (id: DashboardSourceId) => {
      const partner = id === 'credentials' ? 'traffic' : id === 'traffic' ? 'credentials' : null;
      const requested = resources[id].refresh();
      if (partner) await Promise.allSettled([requested, resources[partner].refresh()]);
      await requested;
    },
    [resources]
  );

  /**
   * Header "Refresh all". Rejects when any source fails, naming the failures, so the
   * header never reports success for a partial refresh.
   */
  const refresh = useCallback(async () => {
    if (!connected) return;
    const results = await Promise.allSettled(
      DASHBOARD_SOURCE_IDS.map((id) => resources[id].refresh())
    );
    const failed = DASHBOARD_SOURCE_IDS.filter((_, index) => results[index].status === 'rejected');
    if (failed.length > 0) {
      throw new Error(failed.map((id) => t(`dashboard.source_${id}`)).join(', '));
    }
  }, [connected, resources, t]);

  return {
    connectionStatus,
    connected,
    config,
    counts,
    traffic: fleet.traffic,
    providers: fleet.providers,
    credentials: fleet.credentials,
    credentialFiles: credentialsResource.data?.files ?? [],
    credentialFilesReady:
      credentialsResource.receivedAt !== null && credentialsResource.error === null,
    usage: usageResource.data,
    sources,
    refresh,
    retrySource,
  };
}
