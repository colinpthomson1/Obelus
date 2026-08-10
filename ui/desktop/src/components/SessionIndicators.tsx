import { AlertCircle } from 'lucide-react';
import React from 'react';
import { defineMessages, useIntl } from '../i18n';
import { ObelusLoader } from './brand/ObelusLoader';

const i18n = defineMessages({
  error: {
    id: 'sessionIndicators.error',
    defaultMessage: 'Session encountered an error',
  },
  streaming: {
    id: 'sessionIndicators.streaming',
    defaultMessage: 'Streaming',
  },
  newActivity: {
    id: 'sessionIndicators.newActivity',
    defaultMessage: 'Has new activity',
  },
});

interface SessionIndicatorsProps {
  isStreaming: boolean;
  hasUnread: boolean;
  hasError: boolean;
}

/**
 * Visual indicators for session status (priority order: error > streaming > unread)
 */
export const SessionIndicators = React.memo<SessionIndicatorsProps>(
  ({ isStreaming, hasUnread, hasError }) => {
    const intl = useIntl();

    if (hasError) {
      return (
        <div className="flex items-center gap-1" role="status">
          <AlertCircle className="h-3.5 w-3.5 text-status-disputed" aria-hidden="true" />
          <span className="sr-only">{intl.formatMessage(i18n.error)}</span>
        </div>
      );
    }

    if (isStreaming) {
      return (
        <div className="flex items-center gap-1">
          <ObelusLoader
            variant="proof-pulse"
            label={intl.formatMessage(i18n.streaming)}
            className="!h-3.5 !w-3.5 text-brand-aqua"
          />
        </div>
      );
    }

    if (hasUnread) {
      return (
        <div className="flex items-center gap-1" role="status">
          <div className="h-2 w-2 rounded-full bg-brand-aqua" aria-hidden="true" />
          <span className="sr-only">{intl.formatMessage(i18n.newActivity)}</span>
        </div>
      );
    }

    return null;
  }
);

SessionIndicators.displayName = 'SessionIndicators';
