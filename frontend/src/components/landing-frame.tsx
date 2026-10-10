"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** The marketing pages; they run narrower than the app, on one background. */
export const isLanding = (pathname: string) => pathname === "/" || pathname === "/pricing";

/** A centred container for chrome the app and the landing share, at whichever width the current page uses. */
export function ChromeWidth({ className = "", children }: { className?: string; children: ReactNode }) {
  const landing = isLanding(usePathname());
  return <div className={`mx-auto ${landing ? "max-w-page" : "max-w-6xl"} ${className}`}>{children}</div>;
}

export function FooterSurface({ children }: { children: ReactNode }) {
  const landing = isLanding(usePathname());
  return <footer className={landing ? "bg-canvas" : "border-t border-line bg-surface"}>{children}</footer>;
}
