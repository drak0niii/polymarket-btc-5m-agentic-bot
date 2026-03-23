import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

let telemetryInitialized = false;

export function initializeTelemetry(enabled: boolean): void {
  if (!enabled || telemetryInitialized) {
    return;
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
  telemetryInitialized = true;
}

export function isTelemetryInitialized(): boolean {
  return telemetryInitialized;
}