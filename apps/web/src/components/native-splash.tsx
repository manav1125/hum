import type { ReactNode } from "react";

import { publicAsset } from "@/utils/public-asset";

/**
 * Full-screen branded splash shown on native iOS during:
 * - Initial login (behind the ASWebAuthenticationSession Safari sheet)
 * - Biometric session recovery (while Face ID / Touch ID is prompting)
 * - Session validation (while checking if the user is still logged in)
 *
 * Centers the `cue.` wordmark vertically and displays the character
 * illustrations flush at the bottom of the screen.
 */
export function NativeSplash({ children }: { children?: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[var(--surface-base)] text-[var(--content-default)]">
      <span
        className="select-none text-[56px] font-medium leading-none tracking-[-2px] text-[var(--content-emphasised)]"
        style={{ fontFamily: "var(--font-sans)" }}
      >
        cue<span style={{ color: "var(--accent-cue)" }}>.</span>
      </span>
      {children}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 w-full max-w-[900px] -translate-x-1/2"
        style={{ bottom: 0 }}
      >
        <img
          src={publicAsset("/login-background-characters.svg")}
          alt=""
          width={880}
          height={182}
          className="h-auto w-full"
        />
      </div>
    </div>
  );
}
