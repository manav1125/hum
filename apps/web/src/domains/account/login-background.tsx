import { publicAsset } from "@/utils/public-asset";

/**
 * Decorative background for the branded `/account/login` screen.
 *
 * Renders the white `cue.` wordmark and the login background characters SVG
 * anchored to the bottom edge. Purely presentational (`pointer-events-none`)
 * so the form above stays fully interactive.
 */
export function LoginBackground() {
  return (
    <>
      <div className="pointer-events-none absolute top-[120px] left-1/2 z-0 -translate-x-1/2">
        <span
          className="select-none text-[28px] font-medium leading-none tracking-[-1px] text-white"
          style={{ fontFamily: "var(--font-sans)" }}
        >
          cue<span style={{ color: "var(--accent-cue)" }}>.</span>
        </span>
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-0 left-1/2 z-0 w-full max-w-[1100px] -translate-x-1/2"
      >
        <img
          src={publicAsset("/login-background-characters.svg")}
          alt=""
          width={880}
          height={182}
          className="h-auto w-full"
        />
      </div>
    </>
  );
}
