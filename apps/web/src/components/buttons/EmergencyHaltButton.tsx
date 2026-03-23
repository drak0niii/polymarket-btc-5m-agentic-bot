import { useBotState } from '../../hooks/useBotState';
import { apiClient } from '../../lib/api';

export function EmergencyHaltButton() {
  const { botState, refresh } = useBotState();

  const disabled = botState.state === 'stopped' || botState.state === 'halted_hard';

  const handleClick = async () => {
    if (disabled) {
      return;
    }

    await apiClient.haltBot({
      reason: 'emergency halt requested from web dashboard',
      requestedBy: 'web',
      cancelOpenOrders: true,
    });

    await refresh();
  };

  return (
    <button className="action-button" onClick={handleClick} disabled={disabled}>
      Emergency Halt
    </button>
  );
}
