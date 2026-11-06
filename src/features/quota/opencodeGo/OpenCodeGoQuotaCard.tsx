import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { buildResetDisplay } from '@/utils/quota';
import { QuotaMeter } from '../components/QuotaMeter';
import { QuotaResetLabel } from '../components/QuotaResetLabel';
import { bindQuotaClasses } from '../types';
import bodyStyles from '../components/QuotaBody.module.scss';
import cardStyles from '../components/QuotaCard.module.scss';
import { useOpenCodeGoQuota } from './useOpenCodeGoQuota';
import styles from './OpenCodeGoQuotaCard.module.scss';

const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

export function OpenCodeGoQuotaCard() {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const { connected, configured, status, windows, error, checkedAt, refresh } =
    useOpenCodeGoQuota();

  if (!connected || configured === false) return null;

  const loading = status === 'loading';
  const title = t('opencode_go_quota.title', { defaultValue: 'OpenCode Go' });

  return (
    <article className={cardStyles.card} aria-label={title}>
      <header className={cardStyles.head}>
        <span className={cardStyles.iconWrap} aria-hidden="true">
          <span className={cardStyles.iconFallback}>G</span>
        </span>
        <span className={cardStyles.fileName}>{title}</span>
        <span className={styles.badge}>
          {t('opencode_go_quota.badge', { defaultValue: 'Go plan' })}
        </span>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void refresh()}
          disabled={loading}
          aria-label={t('opencode_go_quota.refresh', { defaultValue: 'Refresh Go usage' })}
          title={t('opencode_go_quota.refresh', { defaultValue: 'Refresh Go usage' })}
        >
          <IconRefreshCw size={14} className={loading ? cardStyles.spinning : undefined} />
        </button>
      </header>

      {status === 'error' && (
        <div className={cardStyles.errorStrip} role="alert">
          {t('opencode_go_quota.error', {
            message: error,
            defaultValue: 'Could not load Go usage: {{message}}',
          })}
        </div>
      )}

      {loading && windows.length === 0 ? (
        <div className={styles.rows} aria-busy="true" aria-label={t('opencode_go_quota.loading')}>
          {[0, 1, 2].map((row) => (
            <div key={row} className={styles.skeletonRow} />
          ))}
        </div>
      ) : windows.length > 0 ? (
        <div className={styles.rows}>
          {windows.map((window, index) => {
            const display =
              window.resetAtMs === null
                ? null
                : buildResetDisplay(null, window.resetAtMs, now, i18n.resolvedLanguage);
            return (
              <div key={window.id} className={quotaClasses.quotaRow}>
                <div className={`${quotaClasses.quotaRowHeader} ${styles.rowHeader}`}>
                  <span className={quotaClasses.quotaModel}>
                    {t(`opencode_go_quota.${window.id}`, {
                      defaultValue:
                        window.id === 'rolling'
                          ? 'Rolling (5h)'
                          : window.id === 'weekly'
                            ? 'Weekly'
                            : 'Monthly',
                    })}
                  </span>
                  <span className={`${quotaClasses.quotaMeta} ${styles.meta}`}>
                    <span className={quotaClasses.quotaPercent}>{window.percent}%</span>
                    {display && <QuotaResetLabel display={display} classes={quotaClasses} />}
                  </span>
                </div>
                <QuotaMeter percent={window.percent} classes={quotaClasses} index={index} />
              </div>
            );
          })}
        </div>
      ) : status === 'idle' ? (
        <button type="button" className={styles.idle} onClick={() => void refresh()}>
          {t('opencode_go_quota.idle', { defaultValue: 'Check Go usage' })}
        </button>
      ) : null}

      {checkedAt !== null && status === 'success' && (
        <p className={styles.checked}>
          {t('opencode_go_quota.checked', {
            time: new Date(checkedAt).toLocaleTimeString(i18n.resolvedLanguage),
            defaultValue: 'checked {{time}}',
          })}
        </p>
      )}
    </article>
  );
}
