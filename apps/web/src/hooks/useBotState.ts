import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  apiClient,
  ApiError,
  type BotStateResponse,
  type RuntimeCommandType,
  type TradingOperatingMode,
} from '../lib/api';

type BotFetchStatus = 'loading' | 'ready' | 'stale' | 'offline';
type CommandPresentationStatus =
  | 'idle'
  | 'submitting'
  | 'queued'
  | 'processing'
  | 'applied'
  | 'failed';

interface CommandPresentation {
  status: CommandPresentationStatus;
  message: string | null;
  commandId: string | null;
}

interface BotStateContextValue {
  botState: BotStateResponse | null;
  fetchStatus: BotFetchStatus;
  fetchError: string | null;
  lastSuccessfulSyncAt: string | null;
  modeLoading: boolean;
  operatingMode: TradingOperatingMode | null;
  modeError: string | null;
  sentinelStatus: BotStateResponse['sentinelStatus'];
  commandStates: Record<RuntimeCommandType, CommandPresentation>;
  setOperatingMode: (operatingMode: TradingOperatingMode) => Promise<void>;
  startBot: () => Promise<void>;
  stopBot: () => Promise<void>;
  haltBot: () => Promise<void>;
  refresh: () => Promise<void>;
  canSubmitControls: boolean;
}

const BotStateContext = createContext<BotStateContextValue | null>(null);

function describeApiError(error: unknown) {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Request failed.';
}

function toCommandPresentation(
  latestCommand: BotStateResponse['controlPlane']['latestCommandByType'][RuntimeCommandType] | null,
  submitting: boolean,
  localError: string | null,
): CommandPresentation {
  if (submitting && !latestCommand) {
    return {
      status: 'submitting',
      message: 'Submitting command to backend...',
      commandId: null,
    };
  }

  if (latestCommand?.status === 'pending') {
    return {
      status: 'queued',
      message: `Queued at ${latestCommand.createdAt}.`,
      commandId: latestCommand.id,
    };
  }

  if (latestCommand?.status === 'processing') {
    return {
      status: 'processing',
      message: 'Worker is processing this command.',
      commandId: latestCommand.id,
    };
  }

  if (latestCommand?.status === 'failed') {
    return {
      status: 'failed',
      message: latestCommand.failureMessage ?? 'The worker reported a failed command.',
      commandId: latestCommand.id,
    };
  }

  if (latestCommand?.status === 'blocked') {
    return {
      status: 'failed',
      message:
        latestCommand.failureMessage ?? 'The backend rejected this command before queueing it.',
      commandId: latestCommand.id,
    };
  }

  if (latestCommand?.status === 'applied') {
    return {
      status: 'applied',
      message: `Applied at ${latestCommand.processedAt ?? latestCommand.updatedAt}.`,
      commandId: latestCommand.id,
    };
  }

  if (submitting) {
    return {
      status: 'submitting',
      message: 'Submitting command to backend...',
      commandId: null,
    };
  }

  if (localError) {
    return {
      status: 'failed',
      message: localError,
      commandId: null,
    };
  }

  return {
    status: 'idle',
    message: null,
    commandId: null,
  };
}

export function BotStateProvider({ children }: { children: ReactNode }) {
  const [botState, setBotState] = useState<BotStateResponse | null>(null);
  const [fetchStatus, setFetchStatus] = useState<BotFetchStatus>('loading');
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<string | null>(null);
  const [modeLoading, setModeLoading] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [commandErrors, setCommandErrors] = useState<Record<RuntimeCommandType, string | null>>({
    start: null,
    stop: null,
    halt: null,
  });
  const [commandSubmitting, setCommandSubmitting] = useState<
    Record<RuntimeCommandType, boolean>
  >({
    start: false,
    stop: false,
    halt: false,
  });
  const commandSubmittingRef = useRef(commandSubmitting);

  const applyFreshState = useCallback((nextState: BotStateResponse) => {
    setBotState(nextState);
    setFetchStatus('ready');
    setFetchError(null);
    setLastSuccessfulSyncAt(new Date().toISOString());
  }, []);

  const refresh = useCallback(async () => {
    try {
      const nextState = await apiClient.getBotState();
      applyFreshState(nextState);
    } catch (error) {
      setFetchError(describeApiError(error));
      setFetchStatus(botState ? 'stale' : 'offline');
    }
  }, [applyFreshState, botState]);

  const runCommand = useCallback(
    async (
      command: RuntimeCommandType,
      request: () => Promise<BotStateResponse>,
    ) => {
      if (commandSubmittingRef.current[command] || fetchStatus !== 'ready') {
        return;
      }

      commandSubmittingRef.current = {
        ...commandSubmittingRef.current,
        [command]: true,
      };
      setCommandSubmitting((current) => ({
        ...current,
        [command]: true,
      }));
      setCommandErrors((current) => ({
        ...current,
        [command]: null,
      }));

      try {
        const nextState = await request();
        applyFreshState(nextState);
      } catch (error) {
        setCommandErrors((current) => ({
          ...current,
          [command]: describeApiError(error),
        }));
        await refresh();
      } finally {
        commandSubmittingRef.current = {
          ...commandSubmittingRef.current,
          [command]: false,
        };
        setCommandSubmitting((current) => ({
          ...current,
          [command]: false,
        }));
      }
    },
    [applyFreshState, fetchStatus, refresh],
  );

  const setOperatingMode = useCallback(
    async (operatingMode: TradingOperatingMode) => {
      if (modeLoading || fetchStatus !== 'ready') {
        return;
      }

      setModeLoading(true);
      setModeError(null);

      if (operatingMode === 'live_trading' && !(botState?.eligibleForLiveTrading ?? false)) {
        setModeError(
          botState?.warningText ??
            botState?.sentinelStatus?.recommendationMessage ??
            'Live trading is blocked by backend readiness truth.',
        );
        setModeLoading(false);
        return;
      }

      try {
        await apiClient.setOperatingMode({
          operatingMode,
          requestedBy: 'web',
        });
        await refresh();
      } catch (error) {
        setModeError(describeApiError(error));
      } finally {
        setModeLoading(false);
      }
    },
    [botState, fetchStatus, modeLoading, refresh],
  );

  const startBot = useCallback(async () => {
    await runCommand('start', () =>
      apiClient.startBot({
        reason: 'start requested from web dashboard',
        requestedBy: 'web',
      }),
    );
  }, [runCommand]);

  const stopBot = useCallback(async () => {
    await runCommand('stop', () =>
      apiClient.stopBot({
        reason: 'stop requested from web dashboard',
        requestedBy: 'web',
        cancelOpenOrders: true,
      }),
    );
  }, [runCommand]);

  const haltBot = useCallback(async () => {
    await runCommand('halt', () =>
      apiClient.haltBot({
        reason: 'emergency halt requested from web dashboard',
        requestedBy: 'web',
        cancelOpenOrders: true,
      }),
    );
  }, [runCommand]);

  useEffect(() => {
    void refresh();

    const interval = window.setInterval(() => {
      void refresh();
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [refresh]);

  const value = useMemo<BotStateContextValue>(() => {
    const latestCommands = botState?.controlPlane.latestCommandByType;

    return {
      botState,
      fetchStatus,
      fetchError,
      lastSuccessfulSyncAt,
      modeLoading,
      operatingMode: botState?.operatingMode ?? null,
      modeError,
      sentinelStatus: botState?.sentinelStatus ?? null,
      commandStates: {
        start: toCommandPresentation(
          latestCommands?.start ?? null,
          commandSubmitting.start,
          commandErrors.start,
        ),
        stop: toCommandPresentation(
          latestCommands?.stop ?? null,
          commandSubmitting.stop,
          commandErrors.stop,
        ),
        halt: toCommandPresentation(
          latestCommands?.halt ?? null,
          commandSubmitting.halt,
          commandErrors.halt,
        ),
      },
      setOperatingMode,
      startBot,
      stopBot,
      haltBot,
      refresh,
      canSubmitControls: fetchStatus === 'ready',
    };
  }, [
    botState,
    commandErrors.halt,
    commandErrors.start,
    commandErrors.stop,
    commandSubmitting.halt,
    commandSubmitting.start,
    commandSubmitting.stop,
    fetchError,
    fetchStatus,
    haltBot,
    lastSuccessfulSyncAt,
    modeError,
    modeLoading,
    refresh,
    setOperatingMode,
    startBot,
    stopBot,
  ]);

  return createElement(BotStateContext.Provider, { value }, children);
}

export function useBotState() {
  const context = useContext(BotStateContext);

  if (!context) {
    throw new Error('useBotState must be used inside BotStateProvider.');
  }

  return context;
}
