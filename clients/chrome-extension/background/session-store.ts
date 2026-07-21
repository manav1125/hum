/**
 * Local storage helpers for the Cue Chrome extension.
 *
 * The extension pairs directly with a Cue gateway over loopback (or a
 * user-provided gateway URL) via `POST /v1/pair` — there is no external
 * identity provider in the shipped extension. These helpers persist the
 * lightweight session/assistant metadata that the diagnostics bundle
 * (Share Feedback) reads. In the single-mode (self-hosted) build they are
 * generally empty, but the accessors are kept so the feedback bundle can
 * surface them if a future build populates them.
 */

import type { ExtensionEnvironment } from './extension-environment.js';

// ── Storage keys ────────────────────────────────────────────────────

// Storage-contract keys (protocol identifiers — stay `vellum` per the
// Cue rebrand boundary; the diagnostics snapshot redactor keys off them).
const SESSION_STORAGE_KEY = 'vellum.cloudSession';
const SELECTED_ASSISTANT_KEY = 'vellum.selectedAssistant';

// ── Types ───────────────────────────────────────────────────────────

/** Lightweight, locally-stored session metadata (diagnostics only). */
export interface CloudSession {
  email: string;
  environment: ExtensionEnvironment;
  organizationId: string | null;
  sessionToken?: string;
  createdAt: number;
}

export interface SelectedAssistant {
  id: string;
  name: string;
}

// ── Session persistence ─────────────────────────────────────────────

export async function getStoredSession(): Promise<CloudSession | null> {
  try {
    const result = await chrome.storage.local.get(SESSION_STORAGE_KEY);
    const stored = result[SESSION_STORAGE_KEY];
    if (
      stored &&
      typeof stored === 'object' &&
      typeof (stored as Record<string, unknown>).email === 'string' &&
      typeof (stored as Record<string, unknown>).environment === 'string'
    ) {
      return stored as CloudSession;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(SESSION_STORAGE_KEY);
}

// ── Selected assistant persistence ──────────────────────────────────

export async function getSelectedAssistant(): Promise<SelectedAssistant | null> {
  try {
    const result = await chrome.storage.local.get(SELECTED_ASSISTANT_KEY);
    const stored = result[SELECTED_ASSISTANT_KEY];
    if (
      stored &&
      typeof stored === 'object' &&
      typeof (stored as Record<string, unknown>).id === 'string' &&
      typeof (stored as Record<string, unknown>).name === 'string'
    ) {
      return stored as SelectedAssistant;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

export async function storeSelectedAssistant(assistant: SelectedAssistant): Promise<void> {
  await chrome.storage.local.set({ [SELECTED_ASSISTANT_KEY]: assistant });
}

export async function clearSelectedAssistant(): Promise<void> {
  await chrome.storage.local.remove(SELECTED_ASSISTANT_KEY);
}
