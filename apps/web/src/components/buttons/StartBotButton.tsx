import { useBotState } from '../../hooks/useBotState';
import { apiClient } from '../../lib/api';

export function StartBotButton() {
  const { botState, refresh } = useBotState();

  const disabled = botState.state !== 'stopped';

  const handleClick = async () => {
    if (disabled) {
      return;
    }

    await apiClient.startBot({
      reason: 'start requested from web dashboard',
      requestedBy: 'web',
    });

    await refresh();
  };

  return (
    <button className="action-button" onClick={handleClick} disabled={disabled}>
      Start
    </button>
  );
}