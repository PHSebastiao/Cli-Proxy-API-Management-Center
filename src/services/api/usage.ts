import { apiClient } from './client';
import type { UsageResponse } from '@/types/usage';

const USAGE_TIMEOUT_MS = 60 * 1000;
const USAGE_FLAG_TIMEOUT_MS = 15 * 1000;

const readStatisticsFlag = (payload: unknown): boolean | null => {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)['usage-statistics-enabled'];
  return typeof value === 'boolean' ? value : null;
};

const isNotFound = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === 'object' &&
      'status' in error &&
      (error as { status?: unknown }).status === 404
  );

// v8 removed the legacy aggregate /usage endpoint. Its panel should skip the
// request entirely instead of logging one 404 per session.
export const supportsLegacyUsage = (version: string | null): boolean => {
  if (!version) return true;
  const match = /^v?(\d+)/i.exec(version.trim());
  if (!match) return true;
  return Number(match[1]) < 8;
};

// Fallback for a v8 server that did not advertise its version: remember the
// 404 so later polls do not keep hitting it.
let usageSnapshotMissing = false;

export const usageApi = {
  getUsage: async (): Promise<UsageResponse> => {
    if (usageSnapshotMissing) return { statistics_enabled: false };
    try {
      return await apiClient.get<UsageResponse>('/usage', { timeout: USAGE_TIMEOUT_MS });
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
      usageSnapshotMissing = true;
      return { statistics_enabled: false };
    }
  },
  /**
   * Whether the server records per-request usage statistics. Null when the backend
   * does not expose the flag (older or upstream servers answer 404).
   */
  getStatisticsEnabled: async (): Promise<boolean | null> => {
    if (usageSnapshotMissing) return false;
    try {
      const payload = await apiClient.get<unknown>('/usage-statistics-enabled', {
        timeout: USAGE_FLAG_TIMEOUT_MS,
      });
      return readStatisticsFlag(payload);
    } catch (error: unknown) {
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 404) return null;
      throw error;
    }
  },
};
