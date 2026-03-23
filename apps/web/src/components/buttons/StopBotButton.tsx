import { useBotState } from '../../hooks/useBotState';
import { apiClient } from '../../lib/api';

export function StopBotButton() {
  const { botState, refresh } = useBotState();

  const disabled =
    botState.state !== 'running' &&
    botState.state !== 'bootstrapping' &&
    botState.state !== 'degraded' &&
    botState.state !== 'reconciliation_only' &&
    botState.state !== 'cancel_only';

  const handleClick = async () => {
    if (disabled) {
      return;
    }

    await apiClient.stopBot({
      reason: 'stop requested from web dashboard',
      requestedBy: 'web',
      cancelOpenOrders: true,
    });

    await refresh();
  };

  return (
    <button className="action-button" onClick={handleClick} disabled={disabled}>
      Stop
    </button>
  );
}
