import { useCallback, useEffect, useState } from 'react';

import { sendMessage } from '../../lib/chrome-message.js';
import type { GatewayUrlGetResponse } from '../../popup-state.js';

const LOOPBACK_DEFAULT = 'http://127.0.0.1:7830';

interface DetectGatewayResponse {
  ok: boolean;
  gatewayUrl?: string | null;
  error?: string;
}

/**
 * Gateway URL entry + connect flow for self-hosted mode.
 *
 * Rendered whenever the extension is in self-hosted mode and NOT currently
 * connected, so the URL field is always reachable for a user whose instance
 * is remote (e.g. https://their-instance.justcue.app) — the loopback default
 * is only a hint, never a silent target.
 *
 * On mount it auto-detects the user's instance from their open Cue tabs and
 * prefills the field, so the common case needs no typing. Connecting routes
 * through the worker's honest connect path: the status card above reflects
 * the real outcome (connecting → connected, or "needs action"), and this
 * field stays visible until a gateway is genuinely reached.
 */
export function SelfHostedSettings() {
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [pairing, setPairing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<string | null>(null);

  // Load the stored URL, then try to auto-detect the instance from open tabs.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await sendMessage<GatewayUrlGetResponse>({
        type: 'gateway-url-get',
      });
      const storedUrl =
        stored?.ok && stored.gatewayUrl ? stored.gatewayUrl : '';
      if (!cancelled && storedUrl && storedUrl !== LOOPBACK_DEFAULT) {
        setGatewayUrl(storedUrl);
      }

      // Auto-detect from open Cue tabs. Prefill when the user hasn't already
      // got a meaningful (non-loopback) URL in the field.
      setDetecting(true);
      const detected = await sendMessage<DetectGatewayResponse>({
        type: 'detect-gateway',
      });
      if (cancelled) return;
      setDetecting(false);
      if (detected?.ok && detected.gatewayUrl) {
        setHint(`Found your instance: ${detected.gatewayUrl}`);
        setGatewayUrl((current) =>
          !current || current === LOOPBACK_DEFAULT
            ? detected.gatewayUrl!
            : current,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runDetect = useCallback(async () => {
    setDetecting(true);
    setHint(null);
    setLocalStatus(null);
    const detected = await sendMessage<DetectGatewayResponse>({
      type: 'detect-gateway',
    });
    setDetecting(false);
    if (detected?.ok && detected.gatewayUrl) {
      setGatewayUrl(detected.gatewayUrl);
      setHint(`Found your instance: ${detected.gatewayUrl}`);
    } else {
      setHint('No open Cue tab found — enter your instance URL.');
    }
  }, []);

  const connect = useCallback(async () => {
    const url = gatewayUrl.trim();
    if (!url) return;

    setPairing(true);
    setLocalStatus(null);

    // Store the URL, then connect. The worker targets exactly this URL — the
    // loopback default never wins once a real URL is stored. The status card
    // reflects the true outcome; this component hides once connected.
    await sendMessage({ type: 'gateway-url-set', gatewayUrl: url });
    const response = await sendMessage<{ ok: boolean; error?: string }>({
      type: 'connect',
    });

    setPairing(false);
    if (response && response.ok === false) {
      setLocalStatus(response.error ?? 'Could not connect');
    }
  }, [gatewayUrl]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !pairing) {
        connect();
      }
    },
    [connect, pairing],
  );

  return (
    <div className="mt-1.5 mb-3.5">
      <div className="mb-1.5 flex items-center justify-between">
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
          Instance URL
        </label>
        <button
          type="button"
          onClick={runDetect}
          disabled={detecting || pairing}
          className="rounded-md border border-edge bg-surface-alt px-2 py-0.5 text-[10px] font-medium text-fg transition-colors hover:border-edge-hover hover:bg-surface disabled:opacity-35 disabled:cursor-default"
        >
          {detecting ? 'Detecting…' : 'Detect open tab'}
        </button>
      </div>
      <div className="flex items-stretch gap-1.5">
        <input
          type="text"
          value={gatewayUrl}
          onChange={(e) => setGatewayUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="https://your-instance.justcue.app"
          className="flex-1 rounded-lg border border-edge bg-bg px-2.5 py-2 font-mono text-[13px] text-fg outline-none transition-colors focus:border-fg-muted"
        />
        <button
          type="button"
          onClick={connect}
          disabled={pairing}
          className="shrink-0 rounded-lg border border-edge bg-surface-alt px-3.5 py-2 text-xs font-medium text-fg transition-colors hover:border-edge-hover hover:bg-surface disabled:opacity-35 disabled:cursor-default"
        >
          {pairing ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-fg-subtle">
        The address of your Cue instance. If you run the desktop app locally,
        use {LOOPBACK_DEFAULT}.
      </p>
      {hint && (
        <p className="mt-1.5 break-all text-[10px] leading-snug text-fg-muted">
          {hint}
        </p>
      )}
      {localStatus && (
        <p className="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-fg-subtle">
          {localStatus}
        </p>
      )}
    </div>
  );
}
