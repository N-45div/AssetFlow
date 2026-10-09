import Link from "next/link";
import type { ReactNode } from "react";
import { PILOT } from "@/lib/site";

/*
 * The landing pages' few primitives. Every section is built from these, so spacing, type, cards and buttons
 * stay identical down the page: one section rhythm, one header, one card, one link style and one pair of actions.
 */

export function Section({ id, tint = false, children }: { id?: string; tint?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={`border-t border-line ${tint ? "bg-canvas" : "bg-surface"}`}>
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">{children}</div>
    </section>
  );
}

export function SectionHeader({ eyebrow, title, lede, as: H = "h2" }: { eyebrow?: string; title: string; lede?: string; as?: "h1" | "h2" }) {
  return (
    <div className="max-w-3xl">
      {eyebrow && <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-accent">{eyebrow}</p>}
      <H className="font-serif text-4xl leading-[1.08] tracking-tight text-ink sm:text-5xl">{title}</H>
      {lede && <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-2">{lede}</p>}
    </div>
  );
}

export function CardGrid({ cols = 3, children }: { cols?: 3 | 4; children: ReactNode }) {
  return <div className={`mt-12 grid gap-6 sm:grid-cols-2 ${cols === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>{children}</div>;
}

export function Card({ label, title, children, footer }: { label?: string; title: string; children?: ReactNode; footer?: ReactNode }) {
  return (
    <article className="card flex flex-col p-6">
      {label && <p className="mono mb-3 text-xs text-accent">{label}</p>}
      <h3 className="text-xl font-semibold leading-snug tracking-tight text-ink">{title}</h3>
      {children && <div className="mt-2 flex-1 text-base leading-relaxed text-ink-2">{children}</div>}
      {footer && <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2">{footer}</div>}
    </article>
  );
}

export function ArrowLink({ href, children }: { href: string; children: ReactNode }) {
  const className = "text-sm font-semibold text-accent hover:underline underline-offset-2";
  return href.startsWith("http") ? (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  ) : (
    <Link className={className} href={href}>
      {children} →
    </Link>
  );
}

/** The page's one pair of actions, in the same order and look wherever it appears. */
export function Actions({ pilot, console }: { pilot: string; console: string }) {
  return (
    <div className="mt-8 flex flex-wrap gap-3">
      <a href={PILOT} className="btn btn-primary" target="_blank" rel="noreferrer">
        {pilot}
      </a>
      <Link href="/issuer" className="btn btn-secondary">
        {console}
      </Link>
    </div>
  );
}
