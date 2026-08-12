import { useEffect } from 'react';
import { useConfig } from './ConfigContext';

const TELEMETRY_CONFIG_KEY = 'GOOSE_TELEMETRY_ENABLED';

export default function TelemetryConsentPrompt() {
  const { upsert } = useConfig();

  useEffect(() => {
    void upsert(TELEMETRY_CONFIG_KEY, false, false).catch((error) => {
      console.error('Failed to disable telemetry:', error);
    });
  }, [upsert]);

  return null;
}
