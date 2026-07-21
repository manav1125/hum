import { useBranding } from '../hooks/use-branding.js';

export interface WelcomeScreenProps {
  onConnect: () => void;
}

export function WelcomeScreen({ onConnect }: WelcomeScreenProps) {
  const branding = useBranding();

  return (
    <div className="flex flex-col items-center justify-center min-h-[320px] px-4 pt-8 pb-4 text-center">
      <img
        src={branding.icons.icon128}
        alt={branding.name}
        className="w-14 h-14 mb-5 animate-fade-up"
        style={{ animationDelay: '0.1s' }}
      />

      <h1
        className="text-xl font-semibold text-fg mb-1.5 animate-fade-up"
        style={{ animationDelay: '0.25s' }}
      >
        {branding.name}
      </h1>

      <p
        className="text-sm text-fg-muted mb-7 animate-fade-up"
        style={{ animationDelay: '0.35s' }}
      >
        Let your Cue assistant work in this browser
      </p>

      <div className="flex flex-col gap-2 w-full max-w-[240px]">
        <button
          type="button"
          onClick={onConnect}
          className="bg-fg text-bg rounded-lg px-4 py-2.5 text-sm font-medium w-full hover:opacity-90 transition-opacity cursor-pointer"
        >
          Connect to Cue
        </button>
      </div>

      <p className="text-xs text-fg-subtle mt-auto pt-4">
        Pairs with your Cue app or hosted instance. No sign-in, no data collection.
      </p>
    </div>
  );
}
