import { useEffect, useState } from 'react';

import { sendMessage } from '../lib/chrome-message.js';

interface SessionState {
  loading: boolean;
  mode: 'self-hosted' | null;
  selfHostedPaired: boolean;
}

interface GetSessionResponse {
  ok: boolean;
  mode: 'self-hosted' | null;
  selfHostedPaired?: boolean;
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({
    loading: true,
    mode: null,
    selfHostedPaired: false,
  });

  useEffect(() => {
    sendMessage<GetSessionResponse>({ type: 'get-session' }).then((response) => {
      if (!response?.ok) {
        setState({
          loading: false,
          mode: null,
          selfHostedPaired: false,
        });
        return;
      }
      setState({
        loading: false,
        mode: response.mode,
        selfHostedPaired: response.selfHostedPaired === true,
      });
    });
  }, []);

  return state;
}
