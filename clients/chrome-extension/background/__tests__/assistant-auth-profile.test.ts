import { describe, expect, test } from 'bun:test';

import {
  resolveAuthProfile,
  type AssistantAuthProfile,
} from '../assistant-auth-profile.js';

describe('resolveAuthProfile', () => {
  test('maps local topology to self-hosted', () => {
    const result = resolveAuthProfile({ cloud: 'local' });
    expect(result).toBe('self-hosted' satisfies AssistantAuthProfile);
  });

  test('maps apple-container topology to self-hosted', () => {
    const result = resolveAuthProfile({ cloud: 'apple-container' });
    expect(result).toBe('self-hosted' satisfies AssistantAuthProfile);
  });

  test('maps unknown topology to unsupported', () => {
    const result = resolveAuthProfile({ cloud: 'some-future-topology' });
    expect(result).toBe('unsupported' satisfies AssistantAuthProfile);
  });

  test('maps empty topology to unsupported', () => {
    const result = resolveAuthProfile({ cloud: '' });
    expect(result).toBe('unsupported' satisfies AssistantAuthProfile);
  });

  test('ignores runtimeUrl when resolving the profile', () => {
    const withUrl = { cloud: 'local', runtimeUrl: 'http://127.0.0.1:7830' };
    const withoutUrl = { cloud: 'local' };
    expect(resolveAuthProfile(withUrl)).toBe('self-hosted');
    expect(resolveAuthProfile(withoutUrl)).toBe('self-hosted');
  });

  test('resolves the full known mapping table', () => {
    const expected: Array<[string, AssistantAuthProfile]> = [
      ['local', 'self-hosted'],
      ['apple-container', 'self-hosted'],
      ['vellum', 'unsupported'],
      ['platform', 'unsupported'],
      ['', 'unsupported'],
    ];
    for (const [cloud, profile] of expected) {
      expect(resolveAuthProfile({ cloud })).toBe(profile);
    }
  });
});
