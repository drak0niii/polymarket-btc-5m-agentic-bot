import { useBotState } from '../../hooks/useBotState';
export function EmergencyHaltButton() {
  const { botState, canSubmitControls, commandStates, haltBot } = useBotState();

  const disabled =
    !canSubmitControls ||
    !botState ||
    botState.state === 'stopped' ||
    botState.state === 'halted_hard' ||
    commandStates.halt.status === 'submitting' ||
    commandStates.halt.status === 'queued' ||
    commandStates.halt.status === 'processing';
  const label =
    commandStates.halt.status === 'submitting'
      ? 'Halting...'
      : commandStates.halt.status === 'queued'
        ? 'Halt Queued'
        : commandStates.halt.status === 'processing'
          ? 'Halting'
          : 'Emergency Halt';

  return (
    <button className="action-button" onClick={() => void haltBot()} disabled={disabled}>
      {label}
    </button>
  );
}
