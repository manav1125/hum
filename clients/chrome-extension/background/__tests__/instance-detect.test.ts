/**
 * Tests for Cue instance auto-detection.
 *
 * Covers:
 *   - normalizeOrigin: scheme/host extraction, rejection of non-http(s).
 *   - isCueSpaTabUrl: /assistant anchor matching.
 *   - candidateGatewayOriginsFromTabs: filtering, de-dup, order preservation.
 *   - probeCueGateway: which statuses count as "a real gateway".
 *   - detectCueGatewayUrl: end-to-end candidate → probe → first reachable.
 */

import { describe, test, expect } from 'bun:test';

import {
  normalizeOrigin,
  isCueSpaTabUrl,
  candidateGatewayOriginsFromTabs,
  probeCueGateway,
  detectCueGatewayUrl,
  PAIR_PROBE_PATH,
} from '../instance-detect.js';

// A minimal fetch stub that records calls and returns a scripted status per
// origin. Anything not in the map rejects (network error), mirroring how a
// non-gateway host behaves.
function makeFetchStub(
  statusByUrl: Record<string, number>,
): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string) => {
    calls.push(input);
    const status = statusByUrl[input];
    if (status === undefined) {
      throw new Error(`network error: ${input}`);
    }
    return { status } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('normalizeOrigin', () => {
  test('extracts scheme://host for https', () => {
    expect(normalizeOrigin('https://manav.justcue.app/assistant/abc')).toBe(
      'https://manav.justcue.app',
    );
  });

  test('preserves an explicit port', () => {
    expect(normalizeOrigin('http://127.0.0.1:7830/assistant')).toBe(
      'http://127.0.0.1:7830',
    );
  });

  test('rejects non-http(s) schemes', () => {
    expect(normalizeOrigin('chrome://extensions')).toBeNull();
    expect(normalizeOrigin('chrome-extension://abc/popup.html')).toBeNull();
    expect(normalizeOrigin('file:///Users/x/index.html')).toBeNull();
  });

  test('returns null for unparseable input', () => {
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
  });
});

describe('isCueSpaTabUrl', () => {
  test('matches the /assistant route and sub-routes', () => {
    expect(isCueSpaTabUrl('https://x.justcue.app/assistant')).toBe(true);
    expect(isCueSpaTabUrl('https://x.justcue.app/assistant/')).toBe(true);
    expect(isCueSpaTabUrl('https://x.justcue.app/assistant/thread/1')).toBe(
      true,
    );
  });

  test('does not match unrelated paths or look-alike prefixes', () => {
    expect(isCueSpaTabUrl('https://x.justcue.app/')).toBe(false);
    expect(isCueSpaTabUrl('https://x.justcue.app/assistants')).toBe(false);
    expect(isCueSpaTabUrl('https://news.example.com/assistant-jobs')).toBe(
      false,
    );
  });

  test('rejects non-http(s) URLs', () => {
    expect(isCueSpaTabUrl('chrome://settings/assistant')).toBe(false);
  });
});

describe('candidateGatewayOriginsFromTabs', () => {
  test('keeps only Cue SPA tabs, de-dups, preserves order', () => {
    const origins = candidateGatewayOriginsFromTabs([
      'https://manav.justcue.app/assistant/1',
      'https://news.example.com/', // not a Cue tab
      'https://manav.justcue.app/assistant/2', // dup origin
      'http://127.0.0.1:7830/assistant', // second distinct origin
      undefined,
      null,
      '', // ignored
    ]);
    expect(origins).toEqual([
      'https://manav.justcue.app',
      'http://127.0.0.1:7830',
    ]);
  });

  test('returns empty when no tab looks like a Cue instance', () => {
    expect(
      candidateGatewayOriginsFromTabs([
        'https://mail.google.com/',
        'chrome://extensions',
      ]),
    ).toEqual([]);
  });
});

describe('probeCueGateway', () => {
  test('treats 200 / 401 / 403 as a real gateway', async () => {
    for (const status of [200, 401, 403]) {
      const { fn } = makeFetchStub({
        [`https://host${PAIR_PROBE_PATH}`]: status,
      });
      expect(await probeCueGateway('https://host', fn)).toBe(true);
    }
  });

  test('rejects 404 and other non-gateway statuses', async () => {
    for (const status of [404, 500, 302]) {
      const { fn } = makeFetchStub({
        [`https://host${PAIR_PROBE_PATH}`]: status,
      });
      expect(await probeCueGateway('https://host', fn)).toBe(false);
    }
  });

  test('resolves false on a network error instead of throwing', async () => {
    const { fn } = makeFetchStub({}); // every fetch rejects
    expect(await probeCueGateway('https://unreachable', fn)).toBe(false);
  });

  test('probes the /v1/pair path with a trailing-slash-safe origin', async () => {
    const { fn, calls } = makeFetchStub({
      [`https://host${PAIR_PROBE_PATH}`]: 403,
    });
    await probeCueGateway('https://host/', fn);
    expect(calls).toEqual([`https://host${PAIR_PROBE_PATH}`]);
  });
});

describe('detectCueGatewayUrl', () => {
  test('returns the first candidate whose gateway probe succeeds', async () => {
    // First candidate is not a gateway (404); second is (403).
    const { fn } = makeFetchStub({
      [`https://a.example.com${PAIR_PROBE_PATH}`]: 404,
      [`https://manav.justcue.app${PAIR_PROBE_PATH}`]: 403,
    });
    const result = await detectCueGatewayUrl(
      [
        'https://a.example.com/assistant/1',
        'https://manav.justcue.app/assistant/home',
      ],
      fn,
    );
    expect(result).toBe('https://manav.justcue.app');
  });

  test('returns null when no candidate is a reachable gateway', async () => {
    const { fn } = makeFetchStub({
      [`https://a.example.com${PAIR_PROBE_PATH}`]: 404,
    });
    const result = await detectCueGatewayUrl(
      ['https://a.example.com/assistant/1'],
      fn,
    );
    expect(result).toBeNull();
  });

  test('returns null when there are no candidate tabs at all', async () => {
    const { fn, calls } = makeFetchStub({});
    const result = await detectCueGatewayUrl(
      ['https://mail.google.com/', 'chrome://extensions'],
      fn,
    );
    expect(result).toBeNull();
    expect(calls).toEqual([]); // never probes non-candidates
  });
});
