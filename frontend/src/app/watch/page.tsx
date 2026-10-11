import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BAND_PCT } from "@/lib/watch/engine";
import { ASSETS, REGISTRY, buildState, type WatchState } from "@/lib/watch/state";
import { WatchBoard } from "./board";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("watch");
  return { title: t("metaTitle"), description: t("lede") };
}

/** Pool Watch: the first snapshot renders on the server; the board then refreshes it and adds the live swaps. */
export default async function WatchPage() {
  let initial: WatchState | null = null;
  try {
    initial = await buildState();
  } catch {
    // the board shows its retry note and fetches again on its own
  }
  return <WatchBoard initial={initial} band={BAND_PCT} officialMints={REGISTRY.officialMints} watched={ASSETS.length} />;
}
