import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { TimeSeriesChart, type TimeSeriesPoint } from '@/components/ui/TimeSeriesChart';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { supportsLegacyUsage, usageApi } from '@/services/api';
import { useAuthStore } from '@/stores';
import type { UsageResponse, UsageSnapshot } from '@/types/usage';
import { buildTopModelRows, buildUsageRows, formatLargeNumber } from '@/utils/usageStats';
import {
  createLatestUsageRequestGuard,
  fetchUsagePageSources,
  runLatestUsageRequest,
  sameUsageSession,
  usageSessionRequestState,
} from './usage-page-request-guard';
import styles from './UsagePage.module.scss';

const STALE_AFTER_MS = 5 * 60_000;

interface UsagePageContentProps {
  payload: UsageResponse | null;
  enabled: boolean | null;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  now: number;
  onRefresh: () => void;
}

function dailyPoints(usage: UsageSnapshot | undefined): TimeSeriesPoint[] {
  const requests = usage?.requests_by_day ?? {};
  const tokens = usage?.tokens_by_day ?? {};
  return [...new Set([...Object.keys(requests), ...Object.keys(tokens)])]
    .filter((day) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
      const timestamp = Date.parse(`${day}T00:00:00Z`);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day;
    })
    .sort()
    .map((day) => ({
      timestamp: Date.parse(`${day}T00:00:00Z`),
      values: {
        requests: Number.isFinite(requests[day]) ? requests[day] : null,
        tokens: Number.isFinite(tokens[day]) ? tokens[day] : null,
      },
    }))
    .filter((point) => point.values.requests !== null || point.values.tokens !== null);
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  const { t, i18n } = useTranslation();
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>
        {value === undefined ? (
          <span title={t('redesign.usage.unreported')} aria-label={t('redesign.usage.unreported')}>
            —
          </span>
        ) : (
          <data value={value} title={value.toLocaleString(i18n.language)}>
            {formatLargeNumber(value)}
          </data>
        )}
      </dd>
    </div>
  );
}

export function UsagePageContent({
  payload,
  enabled,
  loading,
  error,
  lastUpdated,
  now,
  onRefresh,
}: UsagePageContentProps) {
  const { t, i18n } = useTranslation();
  const usage = payload?.usage;
  const apiRows = useMemo(() => buildUsageRows(usage), [usage]);
  const topModels = useMemo(() => buildTopModelRows(apiRows), [apiRows]);
  const points = useMemo(() => dailyPoints(usage), [usage]);
  const ageStale = lastUpdated !== null && now - lastUpdated >= STALE_AFTER_MS;
  const state = loading
    ? 'loading'
    : enabled === false
      ? 'off'
      : error
        ? usage && lastUpdated !== null
          ? 'stale'
          : 'error'
        : enabled === null
          ? 'unknown'
          : ageStale
            ? 'stale'
            : usage?.total_requests === 0
              ? 'empty'
              : 'live';
  const showData =
    enabled !== false && Boolean(usage) && (enabled === true || state === 'stale' || loading);
  const number = (value: number) => value.toLocaleString(i18n.language);
  const dateFormat = new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const formatDate = (timestamp: number) => dateFormat.format(timestamp);
  // Date buckets have no zone metadata. UTC anchors keep their reported calendar date intact.
  const xDomain: [number, number] = points.length
    ? [points[0].timestamp, points[points.length - 1].timestamp]
    : [0, 0];
  const latency = (value: number | undefined) =>
    value === undefined
      ? t('redesign.usage.unreported')
      : t('redesign.usage.milliseconds', { value });

  return (
    <div className={styles.container} data-usage-state={state}>
      <PageHeader
        title={t('usage_stats.title')}
        meta={
          <div className={styles.statusLine} role="status" aria-live="polite">
            <span className={styles.status} data-state={state}>
              {t(`redesign.usage.state_${state}`)}
            </span>
            {lastUpdated !== null && showData && (
              <span>
                {t('usage_stats.last_updated')}{' '}
                <time dateTime={new Date(lastUpdated).toISOString()}>
                  {new Date(lastUpdated).toLocaleString(i18n.language)}
                </time>
              </span>
            )}
          </div>
        }
        actions={
          <Button variant="secondary" size="sm" onClick={onRefresh} loading={loading}>
            {t(error || ageStale ? 'redesign.usage.retry' : 'usage_stats.refresh')}
          </Button>
        }
      />

      {error && (
        <div className={styles.errorBox} role="alert">
          <strong>
            {t(state === 'stale' ? 'redesign.usage.stale_error' : 'usage_stats.load_failed')}
          </strong>
          <p>{error}</p>
        </div>
      )}

      {state === 'off' && (
        <section className={styles.notice} aria-labelledby="usage-off-title">
          <h2 id="usage-off-title">{t('redesign.usage.off_title')}</h2>
          <p>{t('redesign.usage.off_detail')}</p>
          <Link className={styles.actionLink} to="/config?field=usageStatisticsEnabled">
            {t('redesign.usage.open_config')}
          </Link>
        </section>
      )}
      {state === 'unknown' && (
        <section className={styles.notice} aria-labelledby="usage-unknown-title">
          <h2 id="usage-unknown-title">{t('redesign.usage.unknown_title')}</h2>
          <p>{t('redesign.usage.unknown_detail')}</p>
          <Link className={styles.actionLink} to="/system">
            {t('redesign.usage.open_system')}
          </Link>
        </section>
      )}
      {state === 'error' && <p className={styles.note}>{t('redesign.usage.no_cached_data')}</p>}
      {loading && !showData && (
        <div className={styles.loading} role="status" aria-busy="true">
          <LoadingSpinner />
          <span>{t('redesign.usage.state_loading')}</span>
        </div>
      )}

      {showData && (
        <>
          <div className={styles.coverage}>
            <p>{t('redesign.usage.coverage')}</p>
            {loading && <p>{t('redesign.usage.refreshing_cached')}</p>}
            {ageStale && !error && !loading && (
              <p className={styles.staleNote}>{t('redesign.usage.age_stale', { minutes: 5 })}</p>
            )}
            {state === 'empty' && <p>{t('redesign.usage.empty_detail')}</p>}
          </div>
          <dl className={styles.statGrid} aria-busy={loading}>
            <Stat label={t('usage_stats.total_requests')} value={usage?.total_requests} />
            <Stat label={t('usage_stats.total_tokens')} value={usage?.total_tokens} />
            <Stat label={t('usage_stats.success')} value={usage?.success_count} />
            <Stat label={t('usage_stats.failure')} value={usage?.failure_count} />
          </dl>

          <div className={styles.chartGrid}>
            {(['requests', 'tokens'] as const).map((kind) => {
              const title = t(`redesign.usage.${kind}_by_day`);
              return (
                <section
                  key={kind}
                  className={styles.panel}
                  aria-labelledby={`usage-${kind}-title`}
                >
                  <div className={styles.panelHeader}>
                    <h2 id={`usage-${kind}-title`}>{title}</h2>
                  </div>
                  <TimeSeriesChart
                    id={`usage-${kind}`}
                    data={points.some((point) => point.values[kind] !== null) ? points : []}
                    series={[
                      {
                        id: kind,
                        label: t(`usage_stats.${kind}`),
                        color: kind === 'requests' ? 'var(--chart-1)' : 'var(--chart-5)',
                        number: 1,
                      },
                    ]}
                    xDomain={xDomain}
                    formatX={formatDate}
                    formatY={number}
                    ariaLabel={title}
                    description={t('redesign.usage.daily_evidence')}
                    emptyText={t('redesign.usage.no_dated_data')}
                    height={220}
                  />
                </section>
              );
            })}
          </div>

          <section className={styles.panel} aria-labelledby="usage-models-title">
            <div className={styles.panelHeader}>
              <h2 id="usage-models-title">{t('usage_stats.top_models')}</h2>
              <p>{t('redesign.usage.model_evidence')}</p>
            </div>
            {topModels.length === 0 ? (
              <p className={styles.emptyState}>{t('usage_stats.no_data')}</p>
            ) : (
              <div
                className={styles.tableWrap}
                tabIndex={0}
                role="region"
                aria-label={t('usage_stats.top_models')}
              >
                <table className={styles.table}>
                  <caption className={styles.srOnly}>{t('usage_stats.top_models')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('usage_stats.api')}</th>
                      <th scope="col">{t('usage_stats.model')}</th>
                      <th scope="col" className={styles.numberCell}>
                        {t('usage_stats.requests')}
                      </th>
                      <th scope="col" className={styles.numberCell}>
                        {t('usage_stats.tokens')}
                      </th>
                      <th scope="col" className={styles.numberCell}>
                        {t('usage_stats.failures')}
                      </th>
                      <th scope="col" className={styles.numberCell}>
                        {t('redesign.usage.p50')}
                      </th>
                      <th scope="col" className={styles.numberCell}>
                        {t('redesign.usage.p95')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {topModels.map((row) => {
                      const latencies = (
                        usage?.apis?.[row.apiName]?.models?.[row.modelName]?.details ?? []
                      )
                        .map((detail) => detail.latency_ms)
                        .filter(
                          (value): value is number =>
                            typeof value === 'number' && Number.isFinite(value) && value > 0
                        )
                        .sort((a, b) => a - b);
                      return (
                        <tr key={`${row.apiName}:${row.modelName}`}>
                          <td className={styles.mono}>{row.displayApiName}</td>
                          <th scope="row" className={styles.mono}>
                            {row.modelName}
                          </th>
                          <td className={styles.numberCell}>{number(row.requests)}</td>
                          <td className={styles.numberCell}>{number(row.tokens)}</td>
                          <td className={styles.numberCell} data-failed={row.failures > 0}>
                            {number(row.failures)}
                          </td>
                          <td className={styles.numberCell}>
                            {latency(latencies[Math.ceil(latencies.length * 0.5) - 1])}
                          </td>
                          <td className={styles.numberCell}>
                            {latency(latencies[Math.ceil(latencies.length * 0.95) - 1])}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={styles.panel} aria-labelledby="usage-apis-title">
            <div className={styles.panelHeader}>
              <h2 id="usage-apis-title">{t('usage_stats.api_breakdown')}</h2>
            </div>
            {apiRows.length === 0 ? (
              <p className={styles.emptyState}>{t('usage_stats.no_data')}</p>
            ) : (
              <div
                className={styles.tableWrap}
                tabIndex={0}
                role="region"
                aria-label={t('usage_stats.api_breakdown')}
              >
                <table className={styles.table}>
                  <caption className={styles.srOnly}>{t('usage_stats.api_breakdown')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('usage_stats.api')}</th>
                      <th scope="col" className={styles.numberCell}>
                        {t('usage_stats.requests')}
                      </th>
                      <th scope="col" className={styles.numberCell}>
                        {t('usage_stats.tokens')}
                      </th>
                      <th scope="col" className={styles.numberCell}>
                        {t('usage_stats.models')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiRows.map((row) => (
                      <tr key={row.apiName}>
                        <th scope="row" className={styles.mono}>
                          {row.displayApiName}
                        </th>
                        <td className={styles.numberCell}>{number(row.requests)}</td>
                        <td className={styles.numberCell}>{number(row.tokens)}</td>
                        <td className={styles.numberCell}>{number(row.models.length)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export function UsagePage() {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const authenticated = useAuthStore((state) => state.isAuthenticated);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const [payload, setPayload] = useState<UsageResponse | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const requestGuard = useRef(createLatestUsageRequestGuard(useAuthStore.getState));

  const loadUsage = useCallback(() => {
    const session = useAuthStore.getState();
    const requestState = usageSessionRequestState(session);
    if (requestState !== 'ready') {
      if (requestState === 'stopped') setLoading(false);
      return Promise.resolve();
    }
    if (!supportsLegacyUsage(serverVersion)) {
      setEnabled(false);
      setPayload(null);
      setLastUpdated(null);
      setError(null);
      setLoading(false);
      return Promise.resolve();
    }
    return runLatestUsageRequest({
      guard: requestGuard.current,
      request: () => fetchUsagePageSources(usageApi),
      fallbackError: t('usage_stats.load_failed'),
      getResultError: (result) => {
        const messages: string[] = [];
        for (const [source, outcome] of Object.entries(result)) {
          if (outcome.status !== 'rejected') continue;
          // Server error text may contain credentials. Render only a safe source label and HTTP status.
          const reason: unknown = outcome.reason;
          const status =
            reason && typeof reason === 'object' && 'status' in reason ? reason.status : null;
          messages.push(
            t(
              source === 'enabled' ? 'redesign.usage.flag_failed' : 'redesign.usage.snapshot_failed'
            ) +
              (typeof status === 'number' &&
              Number.isInteger(status) &&
              status >= 100 &&
              status <= 599
                ? ` (HTTP ${status})`
                : '')
          );
        }
        return messages.length ? messages.join(' ') : null;
      },
      onStart: () => {
        setLoading(true);
        setError(null);
      },
      onSuccess: (result) => {
        const payloadValue = result.payload.status === 'fulfilled' ? result.payload.value : null;
        const unavailable = payloadValue?.statistics_enabled === false;
        const enabledValue = result.enabled.status === 'fulfilled' ? result.enabled.value : null;
        setEnabled(unavailable ? false : enabledValue);
        if (
          unavailable ||
          (result.enabled.status === 'fulfilled' && result.enabled.value !== true)
        ) {
          setPayload(null);
          setLastUpdated(null);
        } else if (result.enabled.status === 'fulfilled' && result.payload.status === 'fulfilled') {
          const updated = Date.now();
          setPayload(result.payload.value);
          setLastUpdated(updated);
          setNow(updated);
        }
      },
      onError: setError,
      onFinish: () => setLoading(false),
    });
  }, [t, serverVersion]);

  useEffect(() => {
    const guard = requestGuard.current;
    const unsubscribe = useAuthStore.subscribe((session, previous) => {
      if (sameUsageSession(session, previous)) return;
      guard.invalidate();
      setPayload(null);
      setEnabled(null);
      setLastUpdated(null);
      setError(null);
      setLoading(usageSessionRequestState(session) !== 'stopped');
    });
    void loadUsage().catch(() => undefined);
    return () => {
      unsubscribe();
      guard.invalidate();
    };
  }, [loadUsage, apiBase, managementKey, authenticated, connectionStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useHeaderRefresh(loadUsage);

  return (
    <UsagePageContent
      payload={payload}
      enabled={enabled}
      loading={loading}
      error={error}
      lastUpdated={lastUpdated}
      now={now}
      onRefresh={() => void loadUsage().catch(() => undefined)}
    />
  );
}
