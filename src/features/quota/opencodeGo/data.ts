import type { OpenAIProviderConfig } from '@/types';
import { isRecord } from '@/utils/helpers';

export const OPENCODE_GO_PROVIDER = 'opencode-go';

export const OPENCODE_GO_WINDOW_IDS = ['rolling', 'weekly', 'monthly'] as const;
export type OpenCodeGoWindowId = (typeof OPENCODE_GO_WINDOW_IDS)[number];

export interface OpenCodeGoWindow {
  id: OpenCodeGoWindowId;
  percent: number;
  status: string;
  resetAtMs: number | null;
}

export interface OpenCodeGoAuth {
  org: string;
  authIndex: string;
}

const headerValue = (headers: Record<string, string> | undefined, key: string): string => {
  if (!headers) return '';
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return match?.[1]?.trim() ?? '';
};

export const findOpenCodeGoProvider = (
  providers: OpenAIProviderConfig[]
): OpenAIProviderConfig | null =>
  providers.find(
    (provider) =>
      provider.name.trim().toLowerCase() === OPENCODE_GO_PROVIDER && provider.disabled !== true
  ) ?? null;

export const resolveOpenCodeGoAuth = (
  provider: OpenAIProviderConfig
): OpenCodeGoAuth | null => {
  const org = headerValue(provider.headers, 'x-opencode-org-id');
  const authIndex = provider.apiKeyEntries.find((entry) => entry.authIndex)?.authIndex ?? '';
  if (!org || !authIndex) return null;
  return { org, authIndex };
};

const toPercent = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
};

const toResetMs = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const parseOpenCodeGoUsage = (payload: unknown): OpenCodeGoWindow[] => {
  if (!isRecord(payload) || !isRecord(payload.usage)) return [];
  const windows: OpenCodeGoWindow[] = [];
  for (const id of OPENCODE_GO_WINDOW_IDS) {
    const raw = payload.usage[id];
    if (!isRecord(raw)) continue;
    const percent = toPercent(raw.percent);
    if (percent === null) continue;
    windows.push({
      id,
      percent,
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
      resetAtMs: toResetMs(raw.resetsAt),
    });
  }
  return windows;
};
