import { StartBotButton } from '../buttons/StartBotButton';
import { StopBotButton } from '../buttons/StopBotButton';
import { EmergencyHaltButton } from '../buttons/EmergencyHaltButton';
import { useBotState } from '../../hooks/useBotState';

export function ControlPanel() {
  const { botState } = useBotState();

  return (
    <section className="panel">
      <h2 className="panel-title">control</h2>

      <div className="metric-grid" style={{ marginBottom: 12 }}>
        <div className="metric-card">
          <span className="metric-label">state</span>
          <span className="metric-value">{botState.state}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">updated</span>
          <span className="metric-value">
            {botState.lastTransitionAt ?? 'n/a'}
          </span>
        </div>
      </div>

      <div className="panel-copy" style={{ marginBottom: 12 }}>
        {botState.lastTransitionReason ?? 'No transition recorded.'}
      </div>

      <div className="button-row">
        <StartBotButton />
        <StopBotButton />
        <EmergencyHaltButton />
      </div>
    </section>
  );
}