import { ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  title: {
    id: 'telemetrySettings.title',
    defaultMessage: 'Privacy',
  },
  description: {
    id: 'telemetrySettings.description',
    defaultMessage: 'Clear boundaries for this Obelus build',
  },
  analyticsOff: {
    id: 'telemetrySettings.analyticsOff',
    defaultMessage: 'Product analytics are off',
  },
  analyticsOffDescription: {
    id: 'telemetrySettings.analyticsOffDescription',
    defaultMessage:
      'Obelus does not send usage events to an analytics service. Providers, tools, and extensions may still process data you choose to share with them.',
  },
});

export default function TelemetrySettings() {
  const intl = useIntl();

  return (
    <Card className="rounded-lg">
      <CardHeader className="pb-0">
        <CardTitle className="mb-1">{intl.formatMessage(i18n.title)}</CardTitle>
        <CardDescription>{intl.formatMessage(i18n.description)}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4 px-4">
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="h-5 w-5 shrink-0 text-green-700 dark:text-green-300"
            aria-hidden="true"
          />
          <div>
            <h3 className="text-sm font-medium text-text-primary">
              {intl.formatMessage(i18n.analyticsOff)}
            </h3>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-text-secondary">
              {intl.formatMessage(i18n.analyticsOffDescription)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
