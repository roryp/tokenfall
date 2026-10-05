import { shutdownAzureMonitor, useAzureMonitor } from '@azure/monitor-opentelemetry';
import { azureCredential } from './config.ts';
import type { AppConfig } from './config.ts';

let started = false;

// Exports Luna spans to the Application Insights resource connected to the Foundry project.
export function startTelemetry(config: AppConfig) {
  if (started || !config.appInsightsConnectionString) return started;
  process.env.OTEL_SERVICE_NAME ??= 'tokenfall';
  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString: config.appInsightsConnectionString, credential: azureCredential(config) },
    // Every model call is billable, so keep all traces instead of the distro's default five traces per second.
    samplingRatio: 1,
    tracesPerSecond: 0,
    // Keep the traces about Luna: health probes and Socket.IO polling would bury the GenAI spans.
    instrumentationOptions: { http: { enabled: false }, azureSdk: { enabled: false } },
  });
  started = true;
  return started;
}

export async function stopTelemetry() {
  if (!started) return;
  started = false;
  await shutdownAzureMonitor().catch(error => console.warn('Telemetry flush failed:', error instanceof Error ? error.message : 'Unknown error'));
}
