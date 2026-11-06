import { describe, expect, test } from 'bun:test';
import {
  findOpenCodeGoProvider,
  parseOpenCodeGoUsage,
  resolveOpenCodeGoAuth,
} from '@/features/quota/opencodeGo/data';
import type { OpenAIProviderConfig } from '@/types';

const provider = (overrides: Partial<OpenAIProviderConfig> = {}): OpenAIProviderConfig => ({
  name: 'opencode-go',
  baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  headers: { 'x-opencode-org-id': 'wrk_test' },
  apiKeyEntries: [{ apiKey: 'oc_sk_test', authIndex: 'auth_1' }],
  ...overrides,
});

const usage = {
  usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: '2026-11-06T09:39:04.000Z' },
    weekly: { status: 'ok', percent: 13, resetsAt: '2026-11-09T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 63, resetsAt: '2026-11-06T10:59:20.000Z' },
  },
};

describe('parseOpenCodeGoUsage', () => {
  test('reads the three windows in order', () => {
    const windows = parseOpenCodeGoUsage(usage);
    expect(windows.map((window) => window.id)).toEqual(['rolling', 'weekly', 'monthly']);
    expect(windows[0]).toMatchObject({ percent: 1, status: 'ok' });
    expect(windows[0].resetAtMs).toBe(Date.parse('2026-11-06T09:39:04.000Z'));
    expect(windows[2].percent).toBe(63);
  });

  test('clamps percentages and drops malformed windows', () => {
    const windows = parseOpenCodeGoUsage({
      usage: {
        rolling: { status: 'ok', percent: 150, resetsAt: 'not-a-date' },
        weekly: { status: 'ok' },
        monthly: { status: 'ok', percent: -5, resetsAt: null },
      },
    });
    expect(windows.map((window) => window.id)).toEqual(['rolling', 'monthly']);
    expect(windows[0].percent).toBe(100);
    expect(windows[0].resetAtMs).toBeNull();
    expect(windows[1].percent).toBe(0);
  });

  test('returns an empty list for a missing payload', () => {
    expect(parseOpenCodeGoUsage(null)).toEqual([]);
    expect(parseOpenCodeGoUsage({})).toEqual([]);
    expect(parseOpenCodeGoUsage({ usage: {} })).toEqual([]);
  });
});

describe('findOpenCodeGoProvider', () => {
  test('matches the name case-insensitively', () => {
    expect(findOpenCodeGoProvider([provider({ name: 'OpenCode-Go' })])?.name).toBe('OpenCode-Go');
  });

  test('ignores other and disabled providers', () => {
    expect(
      findOpenCodeGoProvider([provider({ name: 'openrouter' }), provider({ disabled: true })])
    ).toBeNull();
  });
});

describe('resolveOpenCodeGoAuth', () => {
  test('reads the org header and the entry auth index', () => {
    expect(resolveOpenCodeGoAuth(provider())).toEqual({ org: 'wrk_test', authIndex: 'auth_1' });
  });

  test('returns null when the org header or auth index is missing', () => {
    expect(resolveOpenCodeGoAuth(provider({ headers: {} }))).toBeNull();
    expect(resolveOpenCodeGoAuth(provider({ apiKeyEntries: [{ apiKey: 'x' }] }))).toBeNull();
  });
});
