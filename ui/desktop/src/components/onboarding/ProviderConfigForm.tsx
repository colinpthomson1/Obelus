import { useState } from 'react';
import { acpAuthenticateProvider } from '../../acp/providers';
import type { ProviderDetails } from '../../types/providers';
import DefaultProviderSetupForm, {
  ConfigInput,
} from '../settings/providers/modal/subcomponents/forms/DefaultProviderSetupForm';
import { providerConfigSubmitHandler } from '../settings/providers/modal/subcomponents/handlers/DefaultSubmitHandler';
import ProviderLogo from '../settings/providers/modal/subcomponents/ProviderLogo';
import { SecureStorageNotice } from '../settings/providers/modal/subcomponents/SecureStorageNotice';
import { Button } from '../ui/button';
import { AlertCircle, ChevronRight, LogIn } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import { errorMessage } from '../../utils/conversionUtils';

type OnConfigured = (name: string) => void | Promise<void>;

const i18n = defineMessages({
  browserWindowOpen: {
    id: 'providerConfigForm.browserWindowOpen',
    defaultMessage: 'Your browser will open so you can finish signing in with the provider.',
  },
  deviceCodeFlowHint: {
    id: 'providerConfigForm.deviceCodeFlowHint',
    defaultMessage:
      'Your browser will open and the verification code will be copied to your clipboard. Paste the code there to finish signing in.',
  },
  signingIn: {
    id: 'providerConfigForm.signingIn',
    defaultMessage: 'Signing in...',
  },
  signInWith: {
    id: 'providerConfigForm.signInWith',
    defaultMessage: 'Sign in with {providerName}',
  },
  noApiKey: {
    id: 'providerConfigForm.noApiKey',
    defaultMessage: "Don't have an API key?",
  },
  configuring: {
    id: 'providerConfigForm.configuring',
    defaultMessage: 'Configuring...',
  },
  continue: {
    id: 'providerConfigForm.continue',
    defaultMessage: 'Continue',
  },
  setupFailed: {
    id: 'providerConfigForm.setupFailed',
    defaultMessage: 'Could not complete setup: {error}',
  },
  fieldRequired: {
    id: 'providerConfigForm.fieldRequired',
    defaultMessage: '{field} is required',
  },
  openExternalLink: {
    id: 'providerConfigForm.openExternalLink',
    defaultMessage: 'Open {url} in your browser',
  },
});

function parseLinks(text: string, openExternalLabel: (url: string) => string) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        onClick={(e) => {
          e.preventDefault();
          window.electron.openExternal(part);
        }}
        className="cursor-pointer rounded-sm text-text-info underline underline-offset-2 hover:text-brand-blue dark:hover:text-brand-aqua"
        aria-label={openExternalLabel(part)}
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}

function OAuthForm({
  provider,
  onConfigured,
  onError,
}: {
  provider: ProviderDetails;
  onConfigured: OnConfigured;
  onError: (msg: string) => void;
}) {
  const intl = useIntl();
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async () => {
    setIsLoading(true);
    try {
      await acpAuthenticateProvider(provider.name);
      await onConfigured(provider.name);
    } catch (err) {
      onError(
        intl.formatMessage(i18n.setupFailed, {
          error: errorMessage(err),
        })
      );
    } finally {
      setIsLoading(false);
    }
  };

  const isDeviceCodeFlow = provider.metadata.config_keys.some((key) => key.device_code_flow);

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <Button
        onClick={handleLogin}
        disabled={isLoading}
        className="flex items-center gap-2 px-6"
        size="lg"
      >
        <LogIn size={20} />
        {isLoading
          ? intl.formatMessage(i18n.signingIn)
          : intl.formatMessage(i18n.signInWith, { providerName: provider.metadata.display_name })}
      </Button>
      <p className="text-center text-xs text-text-secondary">
        {isDeviceCodeFlow
          ? intl.formatMessage(i18n.deviceCodeFlowHint)
          : intl.formatMessage(i18n.browserWindowOpen)}
      </p>
    </div>
  );
}

function ApiKeyForm({
  provider,
  onConfigured,
  onError,
}: {
  provider: ProviderDetails;
  onConfigured: OnConfigured;
  onError: (msg: string) => void;
}) {
  const intl = useIntl();
  const [configValues, setConfigValues] = useState<Record<string, ConfigInput>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSetupHelp, setShowSetupHelp] = useState(false);
  const setupSteps = provider.metadata.setup_steps;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationErrors({});

    const parameters = provider.metadata.config_keys || [];
    const errors: Record<string, string> = {};
    parameters.forEach((param) => {
      if (
        param.required &&
        !configValues[param.name]?.value &&
        !configValues[param.name]?.serverValue
      ) {
        errors[param.name] = intl.formatMessage(i18n.fieldRequired, { field: param.name });
      }
    });

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    const toSubmit = Object.fromEntries(
      Object.entries(configValues)
        .filter(([, entry]) => !!entry.value)
        .map(([k, entry]) => [k, entry.value || ''])
    );

    setIsSubmitting(true);
    try {
      await providerConfigSubmitHandler(provider, toSubmit);
      await onConfigured(provider.name);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <DefaultProviderSetupForm
        configValues={configValues}
        setConfigValues={setConfigValues}
        provider={provider}
        validationErrors={validationErrors}
        showOptions={false}
      />
      {provider.metadata.config_keys.some((k) => k.required && k.secret) && <SecureStorageNotice />}
      {setupSteps && setupSteps.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowSetupHelp(!showSetupHelp)}
            aria-expanded={showSetupHelp}
            aria-controls={`provider-setup-help-${provider.name}`}
            className="flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
          >
            <ChevronRight
              size={14}
              className={`transition-transform duration-200 ${showSetupHelp ? 'rotate-90' : ''}`}
            />
            {intl.formatMessage(i18n.noApiKey)}
          </button>
          {showSetupHelp && (
            <ol
              id={`provider-setup-help-${provider.name}`}
              className="mt-2 ml-5 list-decimal space-y-1 text-sm text-text-secondary"
            >
              {setupSteps.map((step, i) => (
                <li key={i}>
                  {parseLinks(step, (url) => intl.formatMessage(i18n.openExternalLink, { url }))}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <div className="mt-4">
        <Button type="submit" disabled={isSubmitting} className="w-full" size="lg">
          {isSubmitting ? intl.formatMessage(i18n.configuring) : intl.formatMessage(i18n.continue)}
        </Button>
      </div>
    </form>
  );
}

interface ProviderConfigFormProps {
  provider: ProviderDetails;
  onConfigured: OnConfigured;
}

export default function ProviderConfigForm({ provider, onConfigured }: ProviderConfigFormProps) {
  const [error, setError] = useState<string | null>(null);

  const isOAuthProvider = provider.metadata.config_keys.some((key) => key.oauth_flow);

  const renderForm = () => {
    if (isOAuthProvider) {
      return <OAuthForm provider={provider} onConfigured={onConfigured} onError={setError} />;
    }
    return <ApiKeyForm provider={provider} onConfigured={onConfigured} onError={setError} />;
  };

  return (
    <div>
      <div className="rounded-xl border border-border-primary bg-background-secondary p-4">
        <div className="flex items-center gap-3 mb-4">
          <ProviderLogo providerName={provider.name} />
          <div>
            <h3 className="font-medium text-text-primary">{provider.metadata.display_name}</h3>
            <p className="text-xs text-text-secondary">{provider.metadata.description}</p>
          </div>
        </div>

        {renderForm()}

        {error && (
          <div
            role="alert"
            className="mt-3 flex items-start gap-2 rounded-lg border border-status-disputed bg-status-disputed-bg p-3 text-sm text-status-disputed"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
