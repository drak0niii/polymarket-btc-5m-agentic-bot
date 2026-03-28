import { StartBotButton } from '../buttons/StartBotButton';
import { StopBotButton } from '../buttons/StopBotButton';
import { EmergencyHaltButton } from '../buttons/EmergencyHaltButton';
import { useBotState } from '../../hooks/useBotState';

function renderValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') {
    return 'unknown';
  }

  return String(value);
}

export function ControlPanel() {
  const {
    botState,
    fetchStatus,
    fetchError,
    lastSuccessfulSyncAt,
    operatingMode,
    sentinelStatus,
    setOperatingMode,
    modeLoading,
    modeError,
    commandStates,
  } = useBotState();

  const recommendationMessage = sentinelStatus?.recommendationMessage ?? 'Sentinel readiness is unavailable.';
  const statusMessage =
    fetchStatus === 'offline'
      ? `Backend truth unavailable. Controls are disabled. ${fetchError ?? ''}`.trim()
      : fetchStatus === 'stale'
        ? `Showing stale backend truth from ${lastSuccessfulSyncAt ?? 'an unknown time'}. Controls are disabled until refresh recovers.`
        : fetchStatus === 'loading'
          ? 'Loading backend truth...'
          : null;

  return (
    <section className="panel">
      <h2 className="panel-title">control</h2>

      {statusMessage ? (
        <div className="panel-copy" style={{ marginBottom: 12 }}>
          {statusMessage}
        </div>
      ) : null}

      <div className="panel-copy" style={{ marginBottom: 12 }}>
        <div style={{ marginBottom: 8 }}>Operating mode</div>
        <div className="button-row" style={{ marginBottom: 8 }}>
          <button
            className="action-button"
            onClick={() => void setOperatingMode('sentinel_simulation')}
            disabled={
              modeLoading ||
              fetchStatus !== 'ready' ||
              operatingMode === 'sentinel_simulation'
            }
          >
            Sentinel Simulation
          </button>
          <button
            className="action-button"
            onClick={() => void setOperatingMode('live_trading')}
            disabled={
              modeLoading ||
              fetchStatus !== 'ready' ||
              operatingMode === 'live_trading' ||
              !(botState?.eligibleForLiveTrading ?? false)
            }
          >
            Real Trading
          </button>
        </div>
        <div style={{ marginBottom: 8 }}>
          Live eligibility:{' '}
          {botState
            ? botState.eligibleForLiveTrading
              ? 'eligible'
              : 'blocked by backend truth'
            : 'unknown'}
        </div>
        {botState?.warningText ? (
          <div style={{ marginBottom: 8 }}>{botState.warningText}</div>
        ) : null}
        {modeError ? <div>{modeError}</div> : null}
      </div>

      <div className="metric-grid" style={{ marginBottom: 12 }}>
        <div className="metric-card">
          <span className="metric-label">state</span>
          <span className="metric-value">{renderValue(botState?.state)}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">updated</span>
          <span className="metric-value">{renderValue(botState?.lastTransitionAt)}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">mode</span>
          <span className="metric-value">{renderValue(operatingMode)}</span>
        </div>
      </div>

      <div className="panel-copy" style={{ marginBottom: 12 }}>
        {botState?.lastTransitionReason ?? 'No confirmed transition available.'}
      </div>

      {botState && !botState.readiness.ready ? (
        <div className="panel-copy" style={{ marginBottom: 12 }}>
          Start blocked by readiness checks: {botState.readiness.blockingReasons.join(', ')}.
        </div>
      ) : null}

      <div className="panel-copy" style={{ marginBottom: 12 }}>
        Start: {commandStates.start.status}
        {commandStates.start.message ? ` — ${commandStates.start.message}` : ''}
      </div>
      <div className="panel-copy" style={{ marginBottom: 12 }}>
        Stop: {commandStates.stop.status}
        {commandStates.stop.message ? ` — ${commandStates.stop.message}` : ''}
      </div>
      <div className="panel-copy" style={{ marginBottom: 12 }}>
        Halt: {commandStates.halt.status}
        {commandStates.halt.message ? ` — ${commandStates.halt.message}` : ''}
      </div>

      <div
        className="metric-card"
        style={{
          marginBottom: 12,
          borderColor: botState?.recommendedLiveEnable ? '#3d7a45' : '#8a5a1f',
        }}
      >
        <span className="metric-label">Sentinel status</span>
        <span className="metric-value">
          Simulated trades taken: {renderValue(sentinelStatus?.simulatedTradesCompleted)} /{' '}
          {renderValue(sentinelStatus?.targetSimulatedTrades)}
        </span>
        <span className="metric-value">
          Trades learned from: {renderValue(sentinelStatus?.simulatedTradesLearned)} /{' '}
          {renderValue(sentinelStatus?.targetLearnedTrades)}
        </span>
        <span className="metric-value">
          Readiness score:{' '}
          {sentinelStatus ? sentinelStatus.readinessScore.toFixed(2) : 'unknown'} /{' '}
          {renderValue(sentinelStatus?.readinessThreshold)}
        </span>
        <span className="metric-value">
          Recommended: {botState ? (botState.recommendedLiveEnable ? 'Yes' : 'No') : 'unknown'}
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
