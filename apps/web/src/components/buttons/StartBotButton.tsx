import { useBotState } from '../../hooks/useBotState';
export function StartBotButton() {
  const { botState, canSubmitControls, commandStates, startBot } = useBotState();

  const disabled =
    !canSubmitControls ||
    !botState ||
    botState.state !== 'stopped' ||
    commandStates.start.status === 'submitting' ||
    commandStates.start.status === 'queued' ||
    commandStates.start.status === 'processing';
  const label =
    commandStates.start.status === 'submitting'
      ? 'Starting...'
      : commandStates.start.status === 'queued'
        ? 'Start Queued'
        : commandStates.start.status === 'processing'
          ? 'Starting'
          : 'Start';

  return (
    <button className="action-button" onClick={() => void startBot()} disabled={disabled}>
      {label}
    </button>
  );
}
