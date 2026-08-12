import { useState, useEffect, useMemo } from 'react';
import { acpCreateCustomProviderFromRequest, acpListProviderDetails } from '../../acp/providers';
import type { ProviderDetails, UpdateCustomProviderRequest } from '../../types/providers';
import { Select } from '../ui/Select';
import ProviderConfigForm from './ProviderConfigForm';
import LocalModelPicker from './LocalModelPicker';
import CustomProviderForm from '../settings/providers/modal/subcomponents/forms/CustomProviderForm';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { HardDrive, Key, Plus } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import { useFeatures } from '../../contexts/FeaturesContext';

const i18n = defineMessages({
  connectionChoices: {
    id: 'providerSelector.connectionChoices',
    defaultMessage: 'Model connection',
  },
  useLocalModel: {
    id: 'providerSelector.useLocalModel',
    defaultMessage: 'Run a model locally',
  },
  localModelDescription: {
    id: 'providerSelector.localModelDescription',
    defaultMessage: 'Keep model requests on this device. No API key or account is required.',
  },
  connectProvider: {
    id: 'providerSelector.connectProvider',
    defaultMessage: 'Connect a provider',
  },
  connectProviderDescription: {
    id: 'providerSelector.connectProviderDescription',
    defaultMessage: 'Use OpenAI, Anthropic, Google, or another supported provider.',
  },
  selectProvider: {
    id: 'providerSelector.selectProvider',
    defaultMessage: 'Select a provider',
  },
  addCustomProvider: {
    id: 'providerSelector.addCustomProvider',
    defaultMessage: 'Add a custom provider',
  },
  addCustomProviderTitle: {
    id: 'providerSelector.addCustomProviderTitle',
    defaultMessage: 'Add a custom provider',
  },
});

const LOCAL_MODEL = 'local-model' as const;
const OWN_PROVIDER = 'own-provider' as const;

type SelectedPath = typeof LOCAL_MODEL | typeof OWN_PROVIDER | null;

interface ProviderOption {
  value: string;
  label: string;
  provider: ProviderDetails;
}

interface ProviderSelectorProps {
  onConfigured: (providerName: string, modelId?: string) => void | Promise<void>;
  onFirstSelection?: () => void;
}

export default function ProviderSelector({
  onConfigured,
  onFirstSelection,
}: ProviderSelectorProps) {
  const intl = useIntl();
  const { localInference } = useFeatures();
  const [providerList, setProviderList] = useState<ProviderDetails[]>([]);
  const [selectedOption, setSelectedOption] = useState<ProviderOption | null>(null);
  const [selectedPath, setSelectedPath] = useState<SelectedPath>(null);
  const [showCustomModal, setShowCustomModal] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const list = await acpListProviderDetails();
        setProviderList(list);
      } catch (err) {
        console.error('Failed to fetch providers:', err);
      }
    };
    load();
  }, []);

  const options: ProviderOption[] = useMemo(() => {
    return [...providerList]
      .sort((a, b) => {
        const aPreferred = a.provider_type === 'Preferred' ? 0 : 1;
        const bPreferred = b.provider_type === 'Preferred' ? 0 : 1;
        if (aPreferred !== bPreferred) return aPreferred - bPreferred;
        return a.metadata.display_name.localeCompare(b.metadata.display_name);
      })
      .map((provider) => ({
        value: provider.name,
        label: provider.metadata.display_name,
        provider,
      }));
  }, [providerList]);

  const fuzzyFilterOption = (option: { label: string; value: string }, inputValue: string) => {
    const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');
    return (
      normalize(option.label).includes(normalize(inputValue)) ||
      normalize(option.value).includes(normalize(inputValue))
    );
  };

  const handleLocalModelClick = () => {
    setSelectedPath(LOCAL_MODEL);
    setSelectedOption(null);
    onFirstSelection?.();
  };

  const handleOwnProviderClick = () => {
    setSelectedPath(OWN_PROVIDER);
    onFirstSelection?.();
  };

  const handleProviderSelect = (option: ProviderOption | null) => {
    setSelectedOption(option);
    if (option) onFirstSelection?.();
  };

  const handleCreateCustomProvider = async (data: UpdateCustomProviderRequest) => {
    const result = await acpCreateCustomProviderFromRequest(data);
    setShowCustomModal(false);
    if (result.provider_name) {
      await onConfigured(result.provider_name);
    }
  };

  const selectedProvider = selectedOption?.provider ?? null;

  return (
    <div>
      <fieldset className={`grid ${localInference ? 'grid-cols-2' : 'grid-cols-1'} mb-6 gap-3`}>
        <legend className="sr-only">{intl.formatMessage(i18n.connectionChoices)}</legend>
        {localInference && (
          <label
            className={`group cursor-pointer rounded-xl border p-4 text-left transition-colors duration-200 focus-within:ring-2 focus-within:ring-ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background-primary ${
              selectedPath === LOCAL_MODEL
                ? 'border-border-info bg-background-tertiary'
                : 'border-border-primary bg-background-secondary hover:border-border-info'
            }`}
          >
            <input
              type="radio"
              name="provider-path"
              value={LOCAL_MODEL}
              checked={selectedPath === LOCAL_MODEL}
              onChange={handleLocalModelClick}
              className="sr-only"
            />
            <HardDrive size={20} className="mb-2 text-text-info" aria-hidden="true" />
            <span className="block text-base font-medium text-text-primary">
              {intl.formatMessage(i18n.useLocalModel)}
            </span>
            <p className="mt-1 text-sm text-text-secondary">
              {intl.formatMessage(i18n.localModelDescription)}
            </p>
          </label>
        )}

        <label
          className={`group cursor-pointer rounded-xl border p-4 text-left transition-colors duration-200 focus-within:ring-2 focus-within:ring-ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background-primary ${
            selectedPath === OWN_PROVIDER
              ? 'border-border-info bg-background-tertiary'
              : 'border-border-primary bg-background-secondary hover:border-border-info'
          }`}
        >
          <input
            type="radio"
            name="provider-path"
            value={OWN_PROVIDER}
            checked={selectedPath === OWN_PROVIDER}
            onChange={handleOwnProviderClick}
            className="sr-only"
          />
          <Key size={20} className="mb-2 text-text-info" aria-hidden="true" />
          <span className="block text-base font-medium text-text-primary">
            {intl.formatMessage(i18n.connectProvider)}
          </span>
          <p className="mt-1 text-sm text-text-secondary">
            {intl.formatMessage(i18n.connectProviderDescription)}
          </p>
        </label>
      </fieldset>

      {localInference && selectedPath === LOCAL_MODEL && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-[var(--ob-motion-standard)]">
          <LocalModelPicker onConfigured={onConfigured} />
        </div>
      )}

      {selectedPath === OWN_PROVIDER && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-[var(--ob-motion-standard)]">
          <div className="mb-4">
            <Select
              options={options}
              value={selectedOption}
              onChange={(option) => handleProviderSelect(option as ProviderOption | null)}
              placeholder={intl.formatMessage(i18n.selectProvider)}
              isClearable
              isSearchable
              autoFocus
              filterOption={fuzzyFilterOption}
            />
          </div>

          <button
            type="button"
            onClick={() => setShowCustomModal(true)}
            className="mb-6 flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring-primary"
          >
            <Plus size={14} aria-hidden="true" />
            <span>{intl.formatMessage(i18n.addCustomProvider)}</span>
          </button>

          {selectedProvider && (
            <ProviderConfigForm
              key={selectedProvider.name}
              provider={selectedProvider}
              onConfigured={onConfigured}
            />
          )}
        </div>
      )}

      <Dialog open={showCustomModal} onOpenChange={setShowCustomModal}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage(i18n.addCustomProviderTitle)}</DialogTitle>
          </DialogHeader>
          <CustomProviderForm
            initialData={null}
            isEditable={true}
            onSubmit={handleCreateCustomProvider}
            onCancel={() => setShowCustomModal(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
