import { useCallback } from 'react';

import { useAppContext } from '../AppContext.js';
import { SelfHostedSettings } from './main/SelfHostedSettings.js';
import { SessionActions } from './main/SessionActions.js';
import { StatusCard } from './main/StatusCard.js';

/**
 * Main screen showing connection status, activity, and the gateway
 * connection controls. The extension has a single (self-hosted) mode.
 *
 * The visible state is derived from the *actual* connection health, never
 * from "the user picked self-hosted mode". A dead gateway attempt therefore
 * reads honestly as "not connected — enter your instance URL" instead of a
 * silent success, and the URL field stays reachable until a real gateway is
 * reached.
 */
export function MainScreen() {
  const { mode, health, operationCount, setScreen, onSignOut } = useAppContext();

  const handleActivityClick = useCallback(() => {
    setScreen({ name: 'activity' });
  }, [setScreen]);

  const handleFeedbackClick = useCallback(() => {
    setScreen({ name: 'feedback' });
  }, [setScreen]);

  const isSelfHosted = mode === 'self-hosted';
  const isConnected = health === 'connected';
  const isConnecting = health === 'connecting' || health === 'reconnecting';

  // Status card: shown once a connection exists or is being attempted, or
  // when the last attempt failed (so the error is visible). Hidden only in
  // the pristine/paused state before any attempt.
  const showStatusCard = isSelfHosted && health !== 'paused';
  // Activity list is only meaningful on a live connection.
  const showConnectedState = isSelfHosted && isConnected;
  // The gateway URL field must ALWAYS be reachable when not truly connected,
  // so a self-hosted user can enter or correct their instance URL. It is
  // hidden only while genuinely connected or actively (re)connecting.
  const showSelfHostedSettings =
    isSelfHosted && !isConnected && !isConnecting;

  return (
    <div className="flex min-h-[calc(300px-32px)] flex-col">
      {showStatusCard && <StatusCard />}

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

      {showSelfHostedSettings && <SelfHostedSettings />}

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

      <SessionActions paired={isConnected} onBack={onSignOut} />
    </div>
  );
}
