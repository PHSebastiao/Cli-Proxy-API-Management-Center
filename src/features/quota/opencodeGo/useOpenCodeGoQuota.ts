import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/stores';
import { apiCallApi, getApiCallErrorMessage, providersApi } from '@/services/api';
import {
  findOpenCodeGoProvider,
  parseOpenCodeGoUsage,
  resolveOpenCodeGoAuth,
  type OpenCodeGoWindow,
} from './data';

const USAGE_URL = 'https://opencode.ai/inference/go/v1/usage';

export type OpenCodeGoQuotaStatus = 'idle' | 'loading' | 'success' | 'error';

export interface OpenCodeGoQuotaState {
  connected: boolean;
  /** null until the first provider lookup; false hides the card entirely. */
  configured: boolean | null;
  status: OpenCodeGoQuotaStatus;
  windows: OpenCodeGoWindow[];
  error: string;
  checkedAt: number | null;
  refresh: () => Promise<void>;
}

const parsePayload = (body: unknown, bodyText: string): unknown => {
  if (body !== null && body !== undefined) return body;
  if (!bodyText) return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
};

export function useOpenCodeGoQuota(): OpenCodeGoQuotaState {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [status, setStatus] = useState<OpenCodeGoQuotaStatus>('idle');
  const [windows, setWindows] = useState<OpenCodeGoWindow[]>([]);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!connected) return;
    const requestId = ++requestRef.current;
    setStatus('loading');
    setError('');

    try {
      const providers = await providersApi.getOpenAIProviders();
      if (requestId !== requestRef.current) return;

      const provider = findOpenCodeGoProvider(providers);
      if (!provider) {
        setConfigured(false);
        setStatus('idle');
        setWindows([]);
        return;
      }
      setConfigured(true);

      const auth = resolveOpenCodeGoAuth(provider);
      if (!auth) {
        throw new Error('OpenCode Go needs x-opencode-org-id and an auth index');
      }

      const result = await apiCallApi.request({
        authIndex: auth.authIndex,
        method: 'GET',
        url: USAGE_URL,
        header: {
          Authorization: 'Bearer $TOKEN$',
          'x-opencode-org-id': auth.org,
          'User-Agent': 'cli-proxy-management-center/1.0',
        },
      });
      if (requestId !== requestRef.current) return;
      if (result.statusCode !== 200) throw new Error(getApiCallErrorMessage(result));

      const parsed = parseOpenCodeGoUsage(parsePayload(result.body, result.bodyText));
      if (!parsed.length) throw new Error('No usage windows returned');

      setWindows(parsed);
      setStatus('success');
      setCheckedAt(Date.now());
    } catch (cause) {
      if (requestId !== requestRef.current) return;
      setConfigured(true);
      setStatus('error');
      setError(cause instanceof Error ? cause.message : 'Request failed');
    }
  }, [connected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { connected, configured, status, windows, error, checkedAt, refresh };
}
