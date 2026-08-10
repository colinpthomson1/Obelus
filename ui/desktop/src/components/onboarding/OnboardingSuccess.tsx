import { Button } from '../ui/button';
import { defineMessages, useIntl } from '../../i18n';
import { CheckCircle2, ShieldCheck } from 'lucide-react';

const i18n = defineMessages({
  localModelReady: {
    id: 'onboardingSuccess.localModelReady',
    defaultMessage: 'Local model ready',
  },
  connectedTo: {
    id: 'onboardingSuccess.connectedTo',
    defaultMessage: 'Connected to {providerName}',
  },
  allSet: {
    id: 'onboardingSuccess.allSet',
    defaultMessage: 'Obelus is ready. Start a research thread or open a project.',
  },
  privacyTitle: {
    id: 'onboardingSuccess.privacyTitle',
    defaultMessage: 'A private starting point',
  },
  privacyDescription: {
    id: 'onboardingSuccess.privacyDescription',
    defaultMessage:
      'Product analytics and automatic updates are off in this build. Model providers, tools, and extensions follow their own data policies.',
  },
  getStarted: {
    id: 'onboardingSuccess.getStarted',
    defaultMessage: 'Open Obelus',
  },
});

interface OnboardingSuccessProps {
  providerName: string;
  isLocalProvider: boolean;
  onFinish: () => void;
}

export default function OnboardingSuccess({
  providerName,
  isLocalProvider,
  onFinish,
}: OnboardingSuccessProps) {
  const intl = useIntl();

  return (
    <div className="h-screen w-full overflow-hidden bg-background-primary">
      <div className="h-full overflow-y-auto">
        <div className="flex flex-col items-center justify-center h-full p-4">
          <div className="max-w-md w-full mx-auto text-center">
            <div className="mb-6">
              <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-status-supported-bg">
                <CheckCircle2 className="h-6 w-6 text-status-supported" aria-hidden="true" />
              </div>
              <h2 className="mb-1 text-xl font-semibold text-text-primary">
                {isLocalProvider
                  ? intl.formatMessage(i18n.localModelReady)
                  : intl.formatMessage(i18n.connectedTo, { providerName })}
              </h2>
              <p className="text-sm text-text-secondary">{intl.formatMessage(i18n.allSet)}</p>
            </div>

            <div className="mb-6 flex w-full items-start gap-3 rounded-xl border border-border-primary p-4 text-left">
              <ShieldCheck
                className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary"
                aria-hidden="true"
              />
              <div>
                <h3 className="mb-1 text-sm font-medium text-text-primary">
                  {intl.formatMessage(i18n.privacyTitle)}
                </h3>
                <p className="text-sm text-text-secondary">
                  {intl.formatMessage(i18n.privacyDescription)}
                </p>
              </div>
            </div>

            <Button onClick={onFinish} className="w-full" size="lg">
              {intl.formatMessage(i18n.getStarted)}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
