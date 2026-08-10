import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useConfig } from '../ConfigContext';
import { useModelAndProvider } from '../ModelAndProviderContext';
import { acpListProviderDetails, acpReadDefaults, acpSaveDefaults } from '../../acp/providers';
import { Button } from '../ui/button';
import { ObelusLockup, ObelusMark } from '../brand/ObelusBrand';
import { ObelusLoader } from '../brand/ObelusLoader';
import ProviderSelector from './ProviderSelector';
import OnboardingSuccess from './OnboardingSuccess';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  welcomeTitle: {
    id: 'onboardingGuard.welcomeTitle',
    defaultMessage: 'Welcome to Obelus',
  },
  welcomeDescription: {
    id: 'onboardingGuard.welcomeDescription',
    defaultMessage:
      'A local AI workspace for careful research and clear answers. Connect a model provider to begin.',
  },
  checkProviderErrorTitle: {
    id: 'onboardingGuard.checkProviderErrorTitle',
    defaultMessage: 'Unable to connect to Obelus',
  },
  checkProviderErrorDescription: {
    id: 'onboardingGuard.checkProviderErrorDescription',
    defaultMessage: 'The local service may still be starting. Wait a moment, then try again.',
  },
  retry: {
    id: 'onboardingGuard.retry',
    defaultMessage: 'Retry',
  },
  checkingProvider: {
    id: 'onboardingGuard.checkingProvider',
    defaultMessage: 'Preparing Obelus…',
  },
});

const TELEMETRY_CONFIG_KEY = 'GOOSE_TELEMETRY_ENABLED';

interface OnboardingGuardProps {
  children: React.ReactNode;
}

export default function OnboardingGuard({ children }: OnboardingGuardProps) {
  const intl = useIntl();
  const navigate = useNavigate();
  const { upsert } = useConfig();
  const { getFallbackModelAndProvider, refreshCurrentModelAndProvider } = useModelAndProvider();

  const [isCheckingProvider, setIsCheckingProvider] = useState(true);
  const [hasProvider, setHasProvider] = useState(false);
  const [checkProviderError, setCheckProviderError] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [configuredProvider, setConfiguredProvider] = useState<{
    id: string;
    displayName: string;
  } | null>(null);

  const checkProvider = async (retries = 3, delay = 1000) => {
    setIsCheckingProvider(true);
    setCheckProviderError(false);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { providerId: provider } = await acpReadDefaults();
        if (provider?.trim()) {
          setHasProvider(true);
          setIsCheckingProvider(false);
          return;
        }

        const fallback = await getFallbackModelAndProvider();
        if (fallback.provider?.trim() && fallback.model?.trim()) {
          const { providerId: configuredProvider, modelId: configuredModel } =
            await acpReadDefaults();
          if (configuredProvider?.trim() && configuredModel?.trim()) {
            await refreshCurrentModelAndProvider();
            setHasProvider(true);
            setIsCheckingProvider(false);
            return;
          }
        }

        setHasProvider(false);
        setIsCheckingProvider(false);
        return;
      } catch (error) {
        console.error(`Error checking provider (attempt ${attempt + 1}/${retries + 1}):`, error);
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    setCheckProviderError(true);
    setIsCheckingProvider(false);
  };

  useEffect(() => {
    checkProvider();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfigured = async (providerName: string, modelId?: string) => {
    const providers = await acpListProviderDetails();
    const matchedProvider = providers.find((p) => p.name === providerName);
    const resolvedModel = modelId ?? matchedProvider?.metadata.default_model ?? null;
    await acpSaveDefaults(providerName, resolvedModel);
    await refreshCurrentModelAndProvider();
    setConfiguredProvider({
      id: providerName,
      displayName: matchedProvider?.metadata.display_name || providerName,
    });
  };

  const finishOnboarding = async () => {
    try {
      await upsert(TELEMETRY_CONFIG_KEY, false, false);
    } catch (error) {
      console.error('Failed to disable telemetry:', error);
    }
    navigate('/', { replace: true });
    setHasProvider(true);
  };

  if (isCheckingProvider) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-background-primary text-text-secondary">
        <ObelusLoader
          variant="obelus-resolve"
          className="!h-12 !w-12 text-brand-blue dark:text-brand-aqua"
          label={intl.formatMessage(i18n.checkingProvider)}
        />
        <p className="text-sm">{intl.formatMessage(i18n.checkingProvider)}</p>
      </div>
    );
  }

  if (checkProviderError) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-background-primary">
        <div className="text-center max-w-md">
          <div className="mb-4">
            <ObelusMark className="mx-auto size-8" />
          </div>
          <h1 className="mb-3 text-xl font-semibold">
            {intl.formatMessage(i18n.checkProviderErrorTitle)}
          </h1>
          <p className="mb-6 text-text-secondary">
            {intl.formatMessage(i18n.checkProviderErrorDescription)}
          </p>
          <Button onClick={() => checkProvider()} size="lg">
            {intl.formatMessage(i18n.retry)}
          </Button>
        </div>
      </div>
    );
  }

  if (hasProvider) {
    return <>{children}</>;
  }

  if (configuredProvider) {
    return (
      <OnboardingSuccess
        providerName={configuredProvider.displayName}
        isLocalProvider={configuredProvider.id === 'local'}
        onFinish={finishOnboarding}
      />
    );
  }

  return (
    <div className="h-screen w-full overflow-hidden bg-background-primary">
      <div className="h-full overflow-y-auto">
        <div
          className={`flex flex-col items-center p-4 pb-8 transition-all duration-[var(--ob-motion-emphasis)] ease-ob-shift ${hasSelection ? 'pt-8' : 'pt-[15vh]'}`}
        >
          <div className="max-w-2xl w-full mx-auto">
            <div
              className={`overflow-hidden text-left transition-all duration-[var(--ob-motion-emphasis)] ease-ob-shift ${hasSelection ? 'max-h-0 opacity-0 mb-0' : 'max-h-60 opacity-100 mb-8'}`}
            >
              <ObelusLockup className="mb-7 h-9" />
              <h1 className="mb-3 text-2xl font-semibold tracking-[-0.025em] sm:text-4xl">
                {intl.formatMessage(i18n.welcomeTitle)}
              </h1>
              <p className="text-base text-text-secondary sm:text-lg">
                {intl.formatMessage(i18n.welcomeDescription)}
              </p>
            </div>

            <ProviderSelector
              onConfigured={handleConfigured}
              onFirstSelection={() => setHasSelection(true)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
