import { CircleOff, ExternalLink } from 'lucide-react';
import { Button } from '../../ui/button';
import { defineMessages, useIntl } from '../../../i18n';

const OBELUS_REPOSITORY_URL = 'https://github.com/colinpthomson1/Obelus';

const i18n = defineMessages({
  currentVersion: {
    id: 'updateSection.currentVersion',
    defaultMessage: 'Current version',
  },
  updateChannelOff: {
    id: 'updateSection.updateChannelOff',
    defaultMessage: 'Automatic updates are off',
  },
  updateChannelDescription: {
    id: 'updateSection.updateChannelDescription',
    defaultMessage:
      'This build is not connected to an Obelus release service. It will not check Goose or any other upstream channel for updates.',
  },
  viewRepository: {
    id: 'updateSection.viewRepository',
    defaultMessage: 'View Obelus repository',
  },
});

export default function UpdateSection() {
  const intl = useIntl();
  const currentVersion = window.electron.getVersion();

  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-2xl tabular-nums text-text-primary">{currentVersion}</p>
        <p className="mt-1 text-xs text-text-secondary">
          {intl.formatMessage(i18n.currentVersion)}
        </p>
      </div>

      <div className="flex items-start gap-3 border-t border-border-subtle pt-4">
        <CircleOff className="h-5 w-5 shrink-0 text-text-secondary" aria-hidden="true" />
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-text-primary">
            {intl.formatMessage(i18n.updateChannelOff)}
          </h3>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-text-secondary">
            {intl.formatMessage(i18n.updateChannelDescription)}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => window.electron.openExternal(OBELUS_REPOSITORY_URL)}
          >
            {intl.formatMessage(i18n.viewRepository)}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
