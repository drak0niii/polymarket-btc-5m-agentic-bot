import { StartBotButton } from '../buttons/StartBotButton';
import { StopBotButton } from '../buttons/StopBotButton';
import { EmergencyHaltButton } from '../buttons/EmergencyHaltButton';
import { useBotState } from '../../hooks/useBotState';

export function ControlPanel() {
  const {
    botState,
    operatingMode,
    sentinelStatus,
    setOperatingMode,
    modeLoading,
    modeError,
  } = useBotState();

  const recommendationMessage =
    sentinelStatus?.recommendationMessage ??
    'Sentinel is still learning. Simulated trades: 0/20. Learned trades: 0/20. Readiness score: 0.00/0.75. Do not enable live trading yet.';

  return (
    <section className="panel">
      <h2 className="panel-title">control</h2>

      <div className="panel-copy" style={{ marginBottom: 12 }}>
        <div style={{ marginBottom: 8 }}>Operating mode</div>
        <div className="button-row" style={{ marginBottom: 8 }}>
          <button
            className="action-button"
            onClick={() => void setOperatingMode('sentinel_simulation')}
            disabled={modeLoading || operatingMode === 'sentinel_simulation'}
          >
            Sentinel Simulation
          </button>
          <button
            className="action-button"
            onClick={() => void setOperatingMode('live_trading')}
            disabled={modeLoading || operatingMode === 'live_trading'}
          >
            Real Trading
          </button>
        </div>
        {modeError ? <div>{modeError}</div> : null}
      </div>

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

        <div className="metric-card">
          <span className="metric-label">mode</span>
          <span className="metric-value">{operatingMode}</span>
        </div>
      </div>

      <div className="panel-copy" style={{ marginBottom: 12 }}>
        {botState.lastTransitionReason ?? 'No transition recorded.'}
      </div>

      <div
        className="metric-card"
        style={{
          marginBottom: 12,
          borderColor: botState.recommendedLiveEnable ? '#3d7a45' : '#8a5a1f',
        }}
      >
        <span className="metric-label">Sentinel status</span>
        <span className="metric-value">
          Simulated trades taken: {sentinelStatus?.simulatedTradesCompleted ?? 0} / 20
        </span>
        <span className="metric-value">
          Trades learned from: {sentinelStatus?.simulatedTradesLearned ?? 0} / 20
        </span>
        <span className="metric-value">
          Readiness score: {(sentinelStatus?.readinessScore ?? 0).toFixed(2)} / 0.75
        </span>
        <span className="metric-value">
          Recommended: {botState.recommendedLiveEnable ? 'Yes' : 'No'}
        </span>
        <div className="panel-copy" style={{ marginTop: 8 }}>
          Message: {recommendationMessage}
        </div>
      </div>

      <div className="button-row">
        <StartBotButton />
        <StopBotButton />
        <EmergencyHaltButton />
      </div>
    </section>
  );
}
