import { lazy, Suspense, useEffect, useState } from "react";

const PrivacyFlowCanvas = lazy(() => import("./PrivacyFlowCanvas"));

/** Load the WebGL proof only when the browser is idle. Reduced-motion users
 * keep the complete textual proof without paying the animation cost. */
export default function DeferredPrivacyFlow({ active }: { active: boolean }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const browserWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const handle = browserWindow.requestIdleCallback
      ? browserWindow.requestIdleCallback(() => setReady(true), { timeout: 1400 })
      : window.setTimeout(() => setReady(true), 500);
    return () => {
      if (browserWindow.cancelIdleCallback) browserWindow.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);

  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <PrivacyFlowCanvas active={active} />
    </Suspense>
  );
}
