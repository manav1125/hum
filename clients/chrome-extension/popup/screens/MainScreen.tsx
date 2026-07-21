import { useCallback, useEffect, useState } from 'react';

import { useAppContext } from '../AppContext.js';
import { sendMessage } from '../lib/chrome-message.js';
import { SelfHostedSettings } from './main/SelfHostedSettings.js';
import { SessionActions } from './main/SessionActions.js';
import { StatusCard } from './main/StatusCard.js';

/**
 * Main screen showing connection status, activity, and the gateway
 * connection controls. The extension has a single (self-hosted) mode.
 */
export function MainScreen() {
  const { mode, operationCount, selfHostedPaired, setScreen, onSignOut } = useAppContext();

  const [paired, setPaired] = useState(selfHostedPaired);

  useEffect(() => {
    sendMessage<{
      ok: boolean;
      mode: 'self-hosted' | null;
      selfHostedPaired?: boolean;
    }>({ type: 'get-session' }).then((response) => {
      if (!response?.ok) return;
      if (response.selfHostedPaired) {
        setPaired(true);
      }
    });
  }, []);

  const handlePaired = useCallback(() => {
    setPaired(true);
  }, []);

  const handleActivityClick = useCallback(() => {
    setScreen({ name: 'activity' });
  }, [setScreen]);

  const handleFeedbackClick = useCallback(() => {
    setScreen({ name: 'feedback' });
  }, [setScreen]);

  const isSelfHosted = mode === 'self-hosted';

  const showConnectedState = isSelfHosted && paired;
  const showSelfHostedSettings = isSelfHosted && !paired;

  return (
    <div className="flex min-h-[calc(300px-32px)] flex-col">
      {showConnectedState && <StatusCard />}

      {showConnectedState && (
        <button
          type="button"
          onClick={handleActivityClick}
          className="mb-2.5 flex w-full cursor-pointer items-center justify-between rounded-xl border border-edge bg-surface px-4 py-3.5 transition-colors hover:border-edge-hover hover:bg-surface-alt"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] font-medium text-fg">Activity</span>
            <span className="rounded-[10px] bg-surface-alt px-2 py-0.5 text-[11px] font-medium text-fg-muted">
              {operationCount}
            </span>
          </div>
          <svg
            className="shrink-0 text-fg-subtle"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
          >
            <path
              d="M5 2L10 7L5 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      {showSelfHostedSettings && <SelfHostedSettings onPaired={handlePaired} />}

      <button
        type="button"
        onClick={handleFeedbackClick}
        className="mb-2.5 flex w-full cursor-pointer items-center justify-between rounded-xl border border-edge bg-surface px-4 py-3.5 transition-colors hover:border-edge-hover hover:bg-surface-alt"
      >
        <span className="text-[13px] font-medium text-fg">Share Feedback</span>
        <svg
          className="shrink-0 text-fg-subtle"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
        >
          <path
            d="M5 2L10 7L5 12"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <SessionActions paired={paired} onBack={onSignOut} />
    </div>
  );
}
