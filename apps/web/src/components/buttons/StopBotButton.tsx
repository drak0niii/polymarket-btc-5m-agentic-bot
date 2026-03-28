import { useBotState } from '../../hooks/useBotState';
export function StopBotButton() {
  const { botState, canSubmitControls, commandStates, stopBot } = useBotState();

  const disabled =
    !canSubmitControls ||
    !botState ||
    (botState.state !== 'running' &&
      botState.state !== 'bootstrapping' &&
      botState.state !== 'degraded' &&
      botState.state !== 'reconciliation_only' &&
      botState.state !== 'cancel_only') ||
    commandStates.stop.status === 'submitting' ||
    commandStates.stop.status === 'queued' ||
    commandStates.stop.status === 'processing';
  const label =
    commandStates.stop.status === 'submitting'
      ? 'Stopping...'
      : commandStates.stop.status === 'queued'
        ? 'Stop Queued'
        : commandStates.stop.status === 'processing'
          ? 'Stopping'
          : 'Stop';

  return (
    <button className="action-button" onClick={() => void stopBot()} disabled={disabled}>
      {label}
    </button>
  );
}
