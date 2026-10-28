"use client";

import { useEffect } from "react";

/**
 * Brings its section into view when the page was opened with that section's #anchor (for example
 * the dashboard's "Collect" button). Needed because the section streams in after a client-side
 * navigation, after the browser has already tried to scroll to the anchor.
 */
export function ScrollIntoViewOnHash({ anchorId }: { anchorId: string }) {
  useEffect(() => {
    if (window.location.hash !== `#${anchorId}`) return;
    // On the next task, so the router's own scroll handling for the navigation has finished.
    const timer = window.setTimeout(() => {
      const target = document.getElementById(anchorId);
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      target.closest("section")?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea")?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [anchorId]);
  return null;
}
