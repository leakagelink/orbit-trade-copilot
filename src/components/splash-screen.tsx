import { useEffect, useState } from "react";

import splashLogo from "@/assets/splash-logo.png";

const HOLD_MS = 1600;
const FADE_MS = 450;

/**
 * Boot splash shown once while the app loads. Fades out after a short hold.
 * Purely presentational — never blocks data loading or navigation.
 */
export function SplashScreen() {
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const hold = window.setTimeout(() => setLeaving(true), HOLD_MS);
    const remove = window.setTimeout(() => setGone(true), HOLD_MS + FADE_MS);
    return () => {
      window.clearTimeout(hold);
      window.clearTimeout(remove);
    };
  }, []);

  if (gone) return null;

  return (
    <div
      aria-hidden="true"
      className={`splash-screen ${leaving ? "splash-screen--leaving" : ""}`}
    >
      <div className="splash-glow" />
      <img
        src={splashLogo}
        alt=""
        width={1024}
        height={1024}
        className="splash-logo"
      />
      <p className="splash-tagline">AI-Powered Algorithmic Trading</p>
      <div className="splash-bar">
        <div className="splash-bar-fill" />
      </div>
    </div>
  );
}
