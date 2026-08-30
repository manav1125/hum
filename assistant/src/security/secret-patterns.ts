/**
 * Prefix-based secret patterns.
 *
 * The list itself lives in `@vellumai/service-contracts/secret-patterns` so
 * the gateway can consume the same one. It used to live here, which put it out
 * of reach of the gateway's log redaction across the package boundary — so the
 * gateway kept a copy, and the copy drifted. This module stays as the
 * assistant-side import path its consumers already use.
 */

export {
  PREFIX_PATTERNS,
  type SecretPrefixPattern,
} from "@vellumai/service-contracts/secret-patterns";
