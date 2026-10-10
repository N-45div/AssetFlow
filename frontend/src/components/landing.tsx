import Link from "next/link";
import type { ReactNode } from "react";
import { PILOT } from "@/lib/site";

/*
 * The landing pages' few primitives. Every section is built from these, so the page reads as one system:
 * one background, one width, one title, one feature recipe, one glass card on one kind of scene, one pair of pills.
 */

export function Section({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-page scroll-mt-20 px-4 py-16 sm:px-6 lg:py-24">
      {children}
    </section>
  );
}

export function Title({ title, lede, as: H = "h2" }: { title: string; lede?: ReactNode; as?: "h1" | "h2" }) {
  return (
    <div className="max-w-xl">
      <H className="font-serif text-4xl leading-[1.08] tracking-tight text-ink sm:text-5xl">{title}</H>
      {lede && <p className="mt-4 text-base leading-relaxed text-ink-2 sm:text-[17px]">{lede}</p>}
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <p className="text-[13px] uppercase tracking-[0.08em] text-ink-3">{children}</p>;
}

/** Label, title, two lines, optional checks and a link, then its scene; scenes line up across a row. */
export function Feature({ label, title, body, checks, link, children }: { label: string; title: string; body: string; checks?: string[]; link?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <Label>{label}</Label>
      <h3 className="mt-2 text-2xl font-medium tracking-tight text-ink">{title}</h3>
      <p className="mt-2 text-base leading-relaxed text-ink-2">{body}</p>
      {checks && (
        <ul className="mt-4 space-y-2">
          {checks.map((c) => (
            <li key={c} className="flex gap-3 text-[15px] text-ink-2">
              <span className="text-accent" aria-hidden="true">
                ✓
              </span>
              {c}
            </li>
          ))}
        </ul>
      )}
      {link && <div className="mt-4">{link}</div>}
      <div className="mt-auto pt-6">{children}</div>
    </div>
  );
}

export type Tone = "sea" | "sky" | "moss" | "sand" | "dusk" | "sage" | "deep";

export function Scene({ tone, className = "", children }: { tone: Tone; className?: string; children: ReactNode }) {
  // layout and padding come from the caller, so a scene can hold a centred card, a grid or a block of text
  return <div className={`scene scene-${tone} ${className}`}>{children}</div>;
}

export function Glass({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`glass w-full p-5 ${className}`}>{children}</div>;
}

export function GlassHead({ title, sub, badge }: { title: ReactNode; sub?: ReactNode; badge?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-sm font-semibold">{title}</p>
        {sub && <p className="mt-0.5 text-xs text-white/70">{sub}</p>}
      </div>
      {badge && <span className="shrink-0 rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-semibold">{badge}</span>}
    </div>
  );
}

export function GlassRows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="mt-3 divide-y divide-white/15 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 py-2">
          <dt className="text-white/75">{k}</dt>
          <dd className="tabular text-right font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A titled paragraph with no box around it, for principles, buyers and reasons. */
export function TextItem({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div>
      <h3 className="text-xl font-medium tracking-tight text-ink">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{children}</p>
      {footer && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">{footer}</div>}
    </div>
  );
}

export function ArrowLink({ href, children }: { href: string; children: ReactNode }) {
  const className = "text-sm font-medium text-accent underline-offset-2 hover:underline";
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

const pill = "inline-flex h-10 items-center rounded-full px-5 text-sm font-medium transition-colors";

/** The page's one pair of actions, in the same order everywhere; inverted when it sits on a scene. */
export function Actions({ pilot, console, onScene = false }: { pilot: string; console: string; onScene?: boolean }) {
  return (
    <div className="mt-8 flex flex-wrap gap-3">
      <a href={PILOT} className={`${pill} ${onScene ? "bg-white text-ink hover:bg-white/90" : "bg-ink text-white hover:bg-ink/85"}`} target="_blank" rel="noreferrer">
        {pilot}
      </a>
      <Link href="/issuer" className={`${pill} ${onScene ? "border border-white/45 text-white hover:bg-white/10" : "border border-line-strong bg-surface text-ink hover:bg-surface-2"}`}>
        {console}
      </Link>
    </div>
  );
}
