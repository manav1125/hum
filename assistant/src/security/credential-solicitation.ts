/**
 * Credential-solicitation detection.
 *
 * The rule: Cue never asks a user to hand it a secret through a chat message.
 * Not a password, not an API key, not an access token, not a 2FA code. The
 * user signs in themselves in their own browser, or supplies the value through
 * the credential store's secure prompt (`credential_store` with
 * `action: "prompt"`), which never puts the value in the conversation.
 *
 * This module is the mechanical backstop for that rule on the surfaces where
 * the agent composes its own text for the user to answer. It exists because
 * prompt guidance alone did not hold: asked to set up a Netlify deploy, the
 * agent rendered a question card whose options were
 *
 *   "Log in with email (I'll provide credentials)"
 *   "Use Netlify CLI instead — I'll give you an access token"
 *
 * and then blocked on it for ten minutes.
 *
 * Detection is deliberately blunt — a secret noun anywhere in the same string
 * as a hand-it-over cue. A false positive costs one reworded question; a false
 * negative costs a password in a chat log. When the check fires, the caller
 * rejects the call and tells the model the two legitimate routes.
 */

/**
 * Nouns that name a secret. `credential(s)` is included: "I'll provide
 * credentials" was the exact live phrasing. Deliberately does NOT include bare
 * "key" or "code" — too many innocent uses.
 */
const SECRET_NOUNS = [
  "password",
  "passwd",
  "passphrase",
  "pass phrase",
  "api key",
  "api-key",
  "apikey",
  "secret key",
  "private key",
  "access token",
  "auth token",
  "authentication token",
  "bearer token",
  "personal access token",
  "refresh token",
  "session token",
  "session cookie",
  "client secret",
  "webhook secret",
  "credential",
  "credentials",
  "2fa code",
  "two-factor code",
  "verification code",
  "one-time code",
  "one time code",
  "otp",
  "pin code",
  "security code",
  "recovery code",
  "backup code",
  "seed phrase",
  "recovery phrase",
] as const;

/**
 * Phrases that mean "route it to me / through this message". A secret noun on
 * its own is fine ("I'll read your API key from the credential store"); a
 * secret noun plus one of these is a solicitation.
 */
const SOLICIT_CUES = [
  "what's your",
  "whats your",
  "what is your",
  "may i have",
  "can you give",
  "could you give",
  "can i get your",
  "please send",
  "please paste",
  "please enter",
  "please share",
  "please provide",
  "i'll provide",
  "ill provide",
  "i will provide",
  "i can provide",
  "you provide",
  "provide your",
  "provide the",
  "provide me",
  "i'll give you",
  "ill give you",
  "i will give you",
  "give me",
  "give you",
  "send me",
  "share your",
  "share the",
  "share it",
  "paste",
  "type in your",
  "type your",
  "enter your",
  "enter the",
  "tell me your",
  "tell me the",
  "hand over",
  "hand me",
  "drop your",
  "drop the",
  "here's my",
  "heres my",
  "here is my",
  "in chat",
  "in the chat",
  "in this chat",
  "in a message",
  "reply with",
  "respond with",
  "i'll log in",
  "ill log in",
  "i will log in",
  "log me in with",
  "sign me in with",
] as const;

/** A single offending fragment, for the rejection message. */
export interface CredentialSolicitation {
  /** Where the text came from, e.g. `questions[0].options[1].label`. */
  readonly field: string;
  /** The offending text, clipped. */
  readonly text: string;
  /** The secret noun that matched. */
  readonly secretTerm: string;
  /** The solicitation cue that matched. */
  readonly cue: string;
}

const MAX_QUOTED_CHARS = 160;

/**
 * Inspect one string. Returns the match, or `null` when the text does not
 * solicit a secret.
 */
export function findCredentialSolicitation(
  text: string | undefined | null,
  field: string,
): CredentialSolicitation | null {
  if (!text) return null;
  // Normalise curly apostrophes so "I’ll provide" matches "i'll provide".
  const haystack = text.toLowerCase().replace(/[‘’ʼ]/g, "'");

  const secretTerm = SECRET_NOUNS.find((noun) => haystack.includes(noun));
  if (!secretTerm) return null;

  const cue = SOLICIT_CUES.find((c) => haystack.includes(c));
  if (!cue) return null;

  return {
    field,
    text:
      text.length > MAX_QUOTED_CHARS
        ? `${text.slice(0, MAX_QUOTED_CHARS)}…`
        : text,
    secretTerm,
    cue,
  };
}

/**
 * Inspect several labelled strings and return every match. Callers pass every
 * piece of model-authored text that will be shown to the user.
 */
export function findCredentialSolicitations(
  fields: ReadonlyArray<{ field: string; text: string | undefined | null }>,
): CredentialSolicitation[] {
  const found: CredentialSolicitation[] = [];
  for (const { field, text } of fields) {
    const match = findCredentialSolicitation(text, field);
    if (match) found.push(match);
  }
  return found;
}

/**
 * The rejection the model reads. Names what tripped, states the rule, and
 * gives the two routes that ARE allowed — so the next attempt is a correct
 * question rather than a reworded solicitation.
 */
export function formatCredentialSolicitationRefusal(
  matches: readonly CredentialSolicitation[],
): string {
  const quoted = matches
    .map((m) => `  - ${m.field}: "${m.text}"`)
    .join("\n");
  return [
    "Refused: this would ask the user to hand you a secret through a chat message.",
    "",
    quoted,
    "",
    "You never accept a password, API key, access token, 2FA code, or any other secret in conversation — not typed, not pasted, not through a question option, and not \"just this once\". Chat messages are stored and logged; secrets sent this way are compromised.",
    "",
    "The two routes that are allowed:",
    "1. The user signs in themselves, in their own browser, on their own machine. Say what they need to sign into and let them do it. If you cannot reach their browser, say that plainly instead of offering to sign in for them.",
    '2. The user supplies a token through `credential_store` with `action: "prompt"` — a secure UI that stores the value without it ever entering the conversation. Ask them to do that; do not ask them to send you the value.',
    "",
    "Non-secret values (usernames, email addresses, Client IDs, Account SIDs, org/team names) are fine to ask for conversationally.",
    "",
    "Rewrite without offering to receive a secret, then try again.",
  ].join("\n");
}
