import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listLocalModels,
  downloadHfModel,
  getLocalModelDownloadProgress,
  cancelLocalModelDownload,
  type DownloadProgress,
  type LocalModelResponse,
} from '../../acp/local-inference';
import { trackOnboardingSetupFailed } from '../../utils/analytics';
import { defineMessages, useIntl } from '../../i18n';
import { errorMessage as formatErrorMessage } from '../../utils/conversionUtils';
import { AlertCircle, CheckCircle2, ChevronDown, Info } from 'lucide-react';
import { ObelusLoader } from '../brand/ObelusLoader';

const i18n = defineMessages({
  checkingModels: {
    id: 'localModelPicker.checkingModels',
    defaultMessage: 'Checking available models...',
  },
  tryAgain: {
    id: 'localModelPicker.tryAgain',
    defaultMessage: 'Try Again',
  },
  bestForMachine: {
    id: 'localModelPicker.bestForMachine',
    defaultMessage: 'Recommended for this device',
  },
  ready: {
    id: 'localModelPicker.ready',
    defaultMessage: 'Ready',
  },
  showOtherSizes: {
    id: 'localModelPicker.showOtherSizes',
    defaultMessage: 'Show {count} other sizes',
  },
  hideOtherSizes: {
    id: 'localModelPicker.hideOtherSizes',
    defaultMessage: 'Hide other sizes',
  },
  selectModel: {
    id: 'localModelPicker.selectModel',
    defaultMessage: 'Select a model',
  },
  useModel: {
    id: 'localModelPicker.useModel',
    defaultMessage: 'Use {modelId}',
  },
  downloadModel: {
    id: 'localModelPicker.downloadModel',
    defaultMessage: 'Download {modelId} ({size})',
  },
  downloading: {
    id: 'localModelPicker.downloading',
    defaultMessage: 'Downloading {modelId}',
  },
  startingDownload: {
    id: 'localModelPicker.startingDownload',
    defaultMessage: 'Starting download...',
  },
  cancelDownload: {
    id: 'localModelPicker.cancelDownload',
    defaultMessage: 'Cancel Download',
  },
  localModelsNote: {
    id: 'localModelPicker.localModelsNote',
    defaultMessage:
      'Model inference stays on this device. Tools and extensions may still connect to external services, so review them before sharing sensitive material. Performance depends on your hardware and model size.',
  },
  failedToLoad: {
    id: 'localModelPicker.failedToLoad',
    defaultMessage: 'Failed to load available models. Please try again.',
  },
  modelNotFound: {
    id: 'localModelPicker.modelNotFound',
    defaultMessage: 'Model not found',
  },
  failedToStartDownload: {
    id: 'localModelPicker.failedToStartDownload',
    defaultMessage: 'Failed to start download. Please try again.',
  },
  lostConnection: {
    id: 'localModelPicker.lostConnection',
    defaultMessage: 'Lost connection to download. Please try again.',
  },
  modelOptions: {
    id: 'localModelPicker.modelOptions',
    defaultMessage: 'Choose a local model',
  },
  downloadFailed: {
    id: 'localModelPicker.downloadFailed',
    defaultMessage: 'The model download failed.',
  },
  secondsRemaining: {
    id: 'localModelPicker.secondsRemaining',
    defaultMessage: 'About {seconds} seconds remaining',
  },
  minutesRemaining: {
    id: 'localModelPicker.minutesRemaining',
    defaultMessage: 'About {minutes} minutes remaining',
  },
});

interface LocalModelPickerProps {
  onConfigured: (providerName: string, modelId: string) => void | Promise<void>;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
};

const formatSize = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb.toFixed(0)}MB`;
};

const LOCAL_PROVIDER = 'local';

type Phase = 'loading' | 'select' | 'downloading' | 'error';

export default function LocalModelPicker({ onConfigured }: LocalModelPickerProps) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('loading');
  const [models, setModels] = useState<LocalModelResponse[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  useEffect(() => {
    const load = async () => {
      try {
        const models = await listLocalModels();
        if (models) {
          setModels(models);

          const alreadyDownloaded = models.find((m) => m.status.state === 'Downloaded');
          if (alreadyDownloaded) {
            setSelectedModelId(alreadyDownloaded.id);
          } else {
            const recommended = models.find((m: LocalModelResponse) => m.recommended);
            if (recommended) setSelectedModelId(recommended.id);
          }
        }
      } catch (error) {
        console.error('Failed to load local models:', error);
        setErrorMessage(intl.formatMessage(i18n.failedToLoad));
        setPhase('error');
        return;
      }
      setPhase('select');
    };
    load();
  }, [intl]);

  const finishSetup = async (modelId: string) => {
    try {
      await onConfigured(LOCAL_PROVIDER, modelId);
    } catch (error) {
      console.error('Failed to finish local model setup:', error);
      setErrorMessage(formatErrorMessage(error));
      trackOnboardingSetupFailed(LOCAL_PROVIDER, 'save_defaults_failed');
      setPhase('error');
    }
  };

  const startDownload = async (modelId: string) => {
    setPhase('downloading');
    setDownloadProgress(null);
    setErrorMessage(null);

    const model = models.find((m) => m.id === modelId);
    if (!model) {
      setErrorMessage(intl.formatMessage(i18n.modelNotFound));
      setPhase('error');
      return;
    }

    try {
      await downloadHfModel({ spec: model.id });
    } catch (error) {
      console.error('Failed to start download:', error);
      setErrorMessage(intl.formatMessage(i18n.failedToStartDownload));
      trackOnboardingSetupFailed(LOCAL_PROVIDER, 'download_start_failed');
      setPhase('error');
      return;
    }

    pollRef.current = setInterval(async () => {
      try {
        const progress = await getLocalModelDownloadProgress(modelId);
        if (!progress) {
          cleanup();
          setErrorMessage(intl.formatMessage(i18n.lostConnection));
          trackOnboardingSetupFailed(LOCAL_PROVIDER, 'progress_missing');
          setPhase('error');
          return;
        }

        setDownloadProgress(progress);
        if (progress.status === 'completed') {
          cleanup();
          setModels((previousModels) =>
            previousModels.map((model) =>
              model.id === modelId
                ? {
                    ...model,
                    status: {
                      ...model.status,
                      state: 'Downloaded',
                      progressPercent: 100,
                      bytesDownloaded: model.sizeBytes,
                      totalBytes: model.sizeBytes,
                    },
                  }
                : model
            )
          );
          await finishSetup(modelId);
        } else if (progress.status === 'failed') {
          cleanup();
          setErrorMessage(progress.error || intl.formatMessage(i18n.downloadFailed));
          trackOnboardingSetupFailed(LOCAL_PROVIDER, progress.error || 'download_failed');
          setPhase('error');
        } else if (progress.status === 'cancelled') {
          cleanup();
          setPhase('select');
        }
      } catch {
        cleanup();
        setErrorMessage(intl.formatMessage(i18n.lostConnection));
        trackOnboardingSetupFailed(LOCAL_PROVIDER, 'progress_poll_failed');
        setPhase('error');
      }
    }, 500);
  };

  const handleCancelDownload = async () => {
    if (phase === 'downloading' && selectedModelId) {
      cleanup();
      try {
        await cancelLocalModelDownload(selectedModelId);
      } catch {
        // best-effort
      }
      setDownloadProgress(null);
      setPhase('select');
    }
  };

  const handlePrimaryAction = async () => {
    if (!selectedModelId) return;
    const model = models.find((m) => m.id === selectedModelId);
    if (!model) return;
    if (model.status.state === 'Downloaded') {
      await finishSetup(model.id);
    } else {
      await startDownload(model.id);
    }
  };

  const recommended = models.find((m) => m.recommended);
  const otherModels = models.filter((m) => m.id !== recommended?.id);
  const selectedModel = models.find((m) => m.id === selectedModelId);

  if (phase === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <ObelusLoader
          variant="proof-pulse"
          className="mb-4 !h-8 !w-8 text-brand-blue dark:text-brand-aqua"
          label={intl.formatMessage(i18n.checkingModels)}
        />
        <p className="text-sm text-text-secondary">{intl.formatMessage(i18n.checkingModels)}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="rounded-xl border border-border-primary bg-background-secondary p-4">
        {phase === 'error' && (
          <div className="space-y-3">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-status-disputed bg-status-disputed-bg p-3 text-status-disputed"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p className="text-sm">{errorMessage}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setErrorMessage(null);
                setPhase('select');
              }}
              className="min-h-11 w-full rounded-lg border border-border-primary bg-transparent px-4 text-sm font-medium text-text-primary transition-colors hover:bg-background-primary"
            >
              {intl.formatMessage(i18n.tryAgain)}
            </button>
          </div>
        )}

        {phase === 'select' && (
          <fieldset className="space-y-3">
            <legend className="sr-only">{intl.formatMessage(i18n.modelOptions)}</legend>
            {recommended && (
              <label
                className={`relative block w-full cursor-pointer rounded-lg border p-4 transition-colors duration-200 focus-within:ring-2 focus-within:ring-ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background-secondary ${
                  selectedModelId === recommended.id
                    ? 'border-border-info bg-background-tertiary'
                    : 'border-border-primary bg-background-primary hover:border-border-info'
                }`}
              >
                <div className="absolute -top-2 -right-2 z-10">
                  <span className="inline-block rounded-full bg-brand-blue-soft px-2 py-0.5 text-xs font-medium text-brand-blue-dark">
                    {intl.formatMessage(i18n.bestForMachine)}
                  </span>
                </div>
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="local-model"
                    checked={selectedModelId === recommended.id}
                    onChange={() => setSelectedModelId(recommended.id)}
                    className="mt-1 h-4 w-4 flex-shrink-0 cursor-pointer accent-[var(--color-border-info)]"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-text-primary">
                        {recommended.id}
                      </span>
                      {recommended.status.state === 'Downloaded' && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-status-supported-bg px-2 py-0.5 text-xs font-medium text-status-supported">
                          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                          {intl.formatMessage(i18n.ready)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      {formatSize(recommended.sizeBytes)}
                    </p>
                  </div>
                </div>
              </label>
            )}

            {otherModels.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowAllModels(!showAllModels)}
                  aria-expanded={showAllModels}
                  aria-controls="other-local-models"
                  className="flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-text-info transition-colors hover:bg-background-tertiary"
                >
                  {showAllModels
                    ? intl.formatMessage(i18n.hideOtherSizes)
                    : intl.formatMessage(i18n.showOtherSizes, { count: otherModels.length })}
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${showAllModels ? 'rotate-180' : ''}`}
                    aria-hidden="true"
                  />
                </button>

                {showAllModels && (
                  <div id="other-local-models" className="mt-2 space-y-2">
                    {otherModels.map((model) => (
                      <label
                        key={model.id}
                        className={`block w-full cursor-pointer rounded-lg border p-4 transition-colors duration-200 focus-within:ring-2 focus-within:ring-ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background-secondary ${
                          selectedModelId === model.id
                            ? 'border-border-info bg-background-tertiary'
                            : 'border-border-primary bg-background-primary hover:border-border-info'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="radio"
                            name="local-model"
                            checked={selectedModelId === model.id}
                            onChange={() => setSelectedModelId(model.id)}
                            className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-[var(--color-border-info)]"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium text-text-primary">
                                {model.id}
                              </span>
                              <span className="text-xs text-text-secondary">
                                {formatSize(model.sizeBytes)}
                              </span>
                              {model.status.state === 'Downloaded' && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-status-supported-bg px-2 py-0.5 text-xs font-medium text-status-supported">
                                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                                  {intl.formatMessage(i18n.ready)}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={handlePrimaryAction}
              disabled={!selectedModelId}
              className="min-h-11 w-full cursor-pointer rounded-lg bg-brand-blue px-4 text-sm font-medium text-brand-cloud transition-colors hover:bg-brand-blue-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              {selectedModel?.status.state === 'Downloaded'
                ? intl.formatMessage(i18n.useModel, { modelId: selectedModel.id })
                : selectedModel
                  ? intl.formatMessage(i18n.downloadModel, {
                      modelId: selectedModel.id,
                      size: formatSize(selectedModel.sizeBytes),
                    })
                  : intl.formatMessage(i18n.selectModel)}
            </button>
          </fieldset>
        )}

        {phase === 'downloading' && selectedModel && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border-primary bg-background-primary p-4">
              <p className="mb-3 text-sm font-medium text-text-primary">
                {intl.formatMessage(i18n.downloading, { modelId: selectedModel.id })}
              </p>

              {downloadProgress ? (
                <div className="flex items-center gap-4">
                  <ObelusLoader
                    variant="progress-divide"
                    progress={downloadProgress.progressPercent / 100}
                    className="!h-12 !w-12 text-brand-blue dark:text-brand-aqua"
                    label={intl.formatMessage(i18n.downloading, { modelId: selectedModel.id })}
                  />
                  <div className="min-w-0 flex-1 space-y-1.5 font-mono text-xs text-text-secondary">
                    <div className="flex justify-between gap-3">
                      <span>
                        {formatBytes(downloadProgress.bytesDownloaded)} of{' '}
                        {formatBytes(downloadProgress.totalBytes)}
                      </span>
                      <span>{downloadProgress.progressPercent.toFixed(0)}%</span>
                    </div>

                    <div className="flex justify-between gap-3">
                      {downloadProgress.speedBps ? (
                        <span>{formatBytes(downloadProgress.speedBps)}/s</span>
                      ) : (
                        <span />
                      )}
                      {downloadProgress.etaSeconds != null && downloadProgress.etaSeconds > 0 && (
                        <span>
                          {downloadProgress.etaSeconds < 60
                            ? intl.formatMessage(i18n.secondsRemaining, {
                                seconds: Math.round(downloadProgress.etaSeconds),
                              })
                            : intl.formatMessage(i18n.minutesRemaining, {
                                minutes: Math.round(downloadProgress.etaSeconds / 60),
                              })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <ObelusLoader
                    variant="proof-pulse"
                    className="!h-5 !w-5 text-brand-blue dark:text-brand-aqua"
                    label={intl.formatMessage(i18n.startingDownload)}
                  />
                  <span className="text-sm text-text-secondary">
                    {intl.formatMessage(i18n.startingDownload)}
                  </span>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={handleCancelDownload}
              className="min-h-11 w-full rounded-lg border border-border-primary bg-transparent px-4 text-sm text-text-secondary transition-colors hover:bg-background-primary hover:text-text-primary"
            >
              {intl.formatMessage(i18n.cancelDownload)}
            </button>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-status-context bg-status-context-bg p-3 text-status-context">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="text-sm leading-relaxed">{intl.formatMessage(i18n.localModelsNote)}</p>
      </div>
    </div>
  );
}
