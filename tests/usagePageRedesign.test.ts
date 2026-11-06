import { describe, expect, test } from 'bun:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { UsagePageContent } from '@/pages/UsagePage';
import type { UsageResponse } from '@/types/usage';
import { createTestI18n, localeParityIssues, productionLocales } from './helpers/locales';

const i18n = await createTestI18n();
const now = Date.UTC(2026, 10, 2, 12);
const secret = 'sk-fixture-private-client-key-123456789';
const payload: UsageResponse = {
  usage: {
    total_requests: 12,
    total_tokens: 1200,
    success_count: 10,
    failure_count: 2,
    requests_by_day: { '2026-10-30': 4, '2026-11-01': 8 },
    tokens_by_day: { '2026-10-30': 400, '2026-11-01': 800 },
    apis: {
      [secret]: {
        total_requests: 12,
        total_tokens: 1200,
        models: {
          'fixture-model': {
            total_requests: 12,
            total_tokens: 1200,
            failure_count: 2,
            details: [
              { timestamp: '2026-11-01T09:01:00Z', latency_ms: 100 },
              { timestamp: '2026-11-01T09:02:00Z', latency_ms: 200 },
              { timestamp: '2026-11-01T09:03:00Z', latency_ms: 300 },
              { timestamp: '2026-11-01T09:04:00Z', latency_ms: 400 },
              { latency_ms: -1 },
              { latency_ms: Number.NaN },
              {},
            ],
          },
          'no-latency-model': { total_requests: 1, total_tokens: 0, details: [{ latency_ms: 0 }] },
        },
      },
    },
  },
};

type Props = ComponentProps<typeof UsagePageContent>;
const render = (overrides: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        MemoryRouter,
        null,
        createElement(UsagePageContent, {
          payload,
          enabled: true,
          unsupported: false,
          loading: false,
          error: null,
          lastUpdated: now,
          now,
          onRefresh: () => {},
          ...overrides,
        })
      )
    )
  );

describe('Usage production states', () => {
  test('disabled collection hides cached counts and offers configuration without writing it', () => {
    const markup = render({ enabled: false });
    expect(markup).toContain('data-usage-state="off"');
    expect(markup).toContain('Usage statistics are off');
    expect(markup).toContain('href="/config?field=usageStatisticsEnabled"');
    expect(markup).not.toContain('<dl');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('fixture-model');
  });

  test('v8 unsupported state explains the removed endpoint without offering config', () => {
    const markup = render({ unsupported: true, enabled: null });
    expect(markup).toContain('data-usage-state="unsupported"');
    expect(markup).toContain('Usage history is unavailable on CLIProxyAPI v8');
    expect(markup).not.toContain('Turn on in Config');
    expect(markup).not.toContain('<dl');
  });

  test('refreshing disabled collection never reveals previously cached metrics', () => {
    const markup = render({ enabled: false, loading: true });
    expect(markup).not.toContain('<dl');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('fixture-model');
  });

  test('unknown flag is not disabled or empty and does not infer support from a payload', () => {
    const markup = render({ enabled: null });
    expect(markup).toContain('data-usage-state="unknown"');
    expect(markup).toContain('does not report its collection status');
    expect(markup).toContain('href="/system"');
    expect(markup).not.toContain('<dl');
    expect(markup).not.toContain('No requests have been recorded');
  });

  test('first loading state never flashes fake zero metrics', () => {
    const markup = render({ payload: null, enabled: null, loading: true, lastUpdated: null });
    expect(markup).toContain('data-usage-state="loading"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('<dl');
    expect(markup).not.toContain('<table');
  });

  test('enabled-but-empty displays genuine zeros and the no-backfill coverage boundary', () => {
    const markup = render({
      payload: {
        usage: {
          total_requests: 0,
          total_tokens: 0,
          success_count: 0,
          failure_count: 0,
        },
      },
    });
    expect(markup).toContain('data-usage-state="empty"');
    expect(markup.match(/<data value="0"/g)).toHaveLength(4);
    expect(markup).toContain('Collection is on. No requests have been recorded yet.');
    expect(markup).toContain('resets on restart');
    expect(markup).toContain('not backfilled');
    expect(markup).toContain('does not report the collection start time');
    expect(markup).not.toContain('since 07:12');
  });

  test('a failed first fetch reports error, never an empty collection', () => {
    const markup = render({
      payload: null,
      error: 'Snapshot fetch failed (HTTP 503)',
      lastUpdated: null,
    });
    expect(markup).toContain('data-usage-state="error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('HTTP 503');
    expect(markup).toContain('No previously verified usage snapshot');
    expect(markup).not.toContain('<dl');
  });

  test('failed refresh preserves measured values and their original timestamp with an explicit stale label', () => {
    const markup = render({ error: 'Snapshot fetch failed (HTTP 502)', now: now + 60_000 });
    expect(markup).toContain('data-usage-state="stale"');
    expect(markup).toContain('Showing the last verified snapshot');
    expect(markup).toContain('HTTP 502');
    expect(markup).toContain('data value="12"');
    expect(markup).toMatch(/datetime="2026-11-02T12:00:00.000Z"/i);
    expect(markup).toContain('fixture-model');
  });

  test('flag failure with a prior snapshot is stale, not proof that collection is off', () => {
    const markup = render({ enabled: null, error: 'Could not check the collection flag.' });
    expect(markup).toContain('data-usage-state="stale"');
    expect(markup).toContain('data value="12"');
    expect(markup).not.toContain('Usage statistics are off');
  });

  test('old snapshots become stale without inventing another successful refresh', () => {
    const markup = render({ now: now + 5 * 60_000 });
    expect(markup).toContain('data-usage-state="stale"');
    expect(markup).toContain('at least 5 minutes old');
    expect(markup).toMatch(/datetime="2026-11-02T12:00:00.000Z"/i);
    expect(markup).not.toContain('role="alert"');
  });

  test('refresh keeps cached values visible, including after an earlier flag failure', () => {
    for (const enabled of [true, null]) {
      const markup = render({ loading: true, enabled });
      expect(markup).toContain('data-usage-state="loading"');
      expect(markup).toContain('previous verified snapshot');
      expect(markup).toContain('data value="12"');
      expect(markup).toContain('aria-busy="true"');
    }
  });

  test('live snapshot uses one page heading, exact tables, masked API identifiers and retained-only latency', () => {
    const markup = render();
    expect(markup).toContain('data-usage-state="live"');
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    expect(markup).toContain('<caption');
    expect(markup).toContain('scope="row"');
    expect(markup).toContain('retained request details only');
    expect(markup).toContain('200 ms');
    expect(markup).toContain('400 ms');
    expect(markup).toContain('Not reported');
    expect(markup).not.toContain('<td>0 ms</td>');
    expect(markup).toContain('sk-fix...6789');
    expect(markup).not.toContain(secret);
    expect(markup).not.toContain('NaN');
    expect(markup).not.toContain('redesign.usage.');
  });

  test('missing fields remain unreported instead of manufacturing zero metrics', () => {
    const markup = render({ payload: { usage: { total_requests: 2 } } });
    expect(markup.match(/title="Not reported"/g)).toHaveLength(3);
    expect(markup).not.toContain('data value="0"');
  });
});

describe('Usage dated evidence', () => {
  test('charts show real latest dated totals and defer exact rows behind disclosures', () => {
    const markup = render();
    expect(markup).toContain('Requests by day');
    expect(markup).toContain('Tokens by day');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('<strong>8</strong>');
    expect(markup).toContain('<strong>800</strong>');
    expect(markup.match(/<summary>View data table<\/summary>/g)).toHaveLength(2);
    const charts = markup.slice(0, markup.indexOf('<section aria-labelledby="usage-models-title"'));
    expect(charts).not.toContain('<table');
    expect(charts).toContain('Missing dates are not backfilled');
  });

  test('hour-of-day totals, malformed dates and bare detail timestamps never turn into fake daily history', () => {
    const markup = render({
      payload: {
        usage: {
          ...payload.usage,
          requests_by_day: { '9': 999, '2026-02-30': 555 },
          tokens_by_day: {},
          requests_by_hour: { '09': 777 },
          tokens_by_hour: { '09': 888 },
        },
      },
    });
    expect(markup.match(/No dated totals reported/g)).toHaveLength(2);
    expect(markup).not.toContain('<td>999</td>');
    expect(markup).not.toContain('<td>555</td>');
    expect(markup).not.toContain('<td>777</td>');
    expect(markup).not.toContain('<td>888</td>');
    expect(markup).not.toContain('Nov 1, 2026');
  });

  test('an absent token series is not rendered as zeros alongside dated request totals', () => {
    const markup = render({
      payload: {
        usage: {
          ...payload.usage,
          tokens_by_day: {},
        },
      },
    });
    expect(markup.match(/No dated totals reported/g)).toHaveLength(1);
    expect(markup).toContain('<strong>8</strong>');
    expect(markup).toContain('<strong>Not reported</strong>');
    expect(markup.match(/<summary>View data table<\/summary>/g)).toHaveLength(1);
    expect(markup).not.toContain('<strong>0</strong>');
  });
});

test('shipped Usage translations have key and interpolation parity in all four languages', () => {
  expect(Object.keys(productionLocales.en.redesign.usage).length).toBeGreaterThan(25);
  expect(localeParityIssues(productionLocales, ['redesign.usage'])).toEqual([]);
});
