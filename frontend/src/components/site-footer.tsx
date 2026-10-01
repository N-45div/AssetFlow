import { getTranslations } from "next-intl/server";

export async function SiteFooter() {
  const t = await getTranslations("footer");
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-sm text-ink-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>{t("line")}</p>
        <a className="hover:text-ink" href="https://github.com/N-45div/AssetFlow">
          {t("source")}
        </a>
      </div>
    </footer>
  );
}
