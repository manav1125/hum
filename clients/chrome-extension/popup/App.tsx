import { useCallback, useEffect, useMemo, useState } from 'react';

import type { OperationEntry } from '../background/event-log.js';
import { AppContext, type Screen } from './AppContext.js';
import { useSession } from './hooks/use-session.js';
import { useStatusPoll } from './hooks/use-status-poll.js';
import { sendMessage } from './lib/chrome-message.js';
import { ActivityScreen } from './screens/ActivityScreen.js';
import { DetailScreen } from './screens/DetailScreen.js';
import { FeedbackScreen } from './screens/FeedbackScreen.js';
import { MainScreen } from './screens/MainScreen.js';
import { WelcomeScreen } from './screens/WelcomeScreen.js';

/**
 * Cue browser relay popup.
 *
 * Single connection mode: the extension pairs with a Cue gateway (the
 * desktop app on loopback, or a user-provided gateway URL) via the
 * gateway's own `/v1/pair` flow. There is no external sign-in.
 */
export function App() {
  const session = useSession();
  const [screen, setScreen] = useState<Screen>({ name: 'welcome' });
  const [mode, setMode] = useState<'self-hosted' | null>(null);
  const [operationCount, setOperationCount] = useState(0);
  const [selfHostedPaired, setSelfHostedPaired] = useState(false);

  // Determine initial screen from session state once loading completes.
  useEffect(() => {
    if (session.loading) return;

    if (session.mode === 'self-hosted') {
      setMode('self-hosted');
      setSelfHostedPaired(!!session.selfHostedPaired);
      setScreen({ name: 'main' });
      if (session.selfHostedPaired) {
        sendMessage({ type: 'connect' });
      }
    } else {
      setScreen({ name: 'welcome' });
    }
  }, [session.loading, session.mode, session.selfHostedPaired]);

  // Poll status when on the main screen.
  const { health, healthDetail, authProfile } = useStatusPoll(screen.name === 'main');

  // Refresh activity count when on the main screen (poll every 2s).
  useEffect(() => {
    if (screen.name !== 'main') return;

    function refreshCount() {
      sendMessage<{ ok: boolean; operations: OperationEntry[] }>({
        type: 'get-operations',
      }).then((response) => {
        if (response?.ok) {
          setOperationCount(response.operations.length);
        }
      });
    }

    refreshCount();
    const interval = setInterval(refreshCount, 2000);
    return () => clearInterval(interval);
  }, [screen.name]);

  // Navigation callbacks

  const handleConnect = useCallback(() => {
    setMode('self-hosted');
    sendMessage({ type: 'set-mode', mode: 'self-hosted' });
    setScreen({ name: 'main' });
  }, []);

  const handleSignOut = useCallback(() => {
    sendMessage({ type: 'self-hosted-disconnect' }).then(() => {
      setMode(null);
      setScreen({ name: 'welcome' });
    });
  }, []);

  const handleSelectOperation = useCallback((op: OperationEntry) => {
    setScreen({ name: 'detail', operation: op });
  }, []);

  const handleBackToMain = useCallback(() => {
    setScreen({ name: 'main' });
  }, []);

  const handleBackToActivity = useCallback(() => {
    setScreen({ name: 'activity' });
  }, []);

  const contextValue = useMemo(
    () => ({
      mode,
      health,
      healthDetail,
      authProfile,
      operationCount,
      selfHostedPaired,
      setScreen,
      onSignOut: handleSignOut,
    }),
    [mode, health, healthDetail, authProfile, operationCount, selfHostedPaired, handleSignOut],
  );

  if (session.loading) {
    return null;
  }

  return (
    <AppContext.Provider value={contextValue}>
      {(() => {
        switch (screen.name) {
          case 'welcome':
            return <WelcomeScreen onConnect={handleConnect} />;
          case 'main':
            return <MainScreen />;
          case 'activity':
            return (
              <ActivityScreen
                onBack={handleBackToMain}
                onSelectOperation={handleSelectOperation}
              />
            );
          case 'detail':
            return (
              <DetailScreen
                operation={screen.operation}
                onBack={handleBackToActivity}
              />
            );
          case 'feedback':
            return <FeedbackScreen onBack={handleBackToMain} />;
        }
      })()}
    </AppContext.Provider>
  );
}
