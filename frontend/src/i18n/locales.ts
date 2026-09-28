/** English for the submission; Simplified and Traditional Chinese for Solar's audience. */
export const LOCALES = ["en", "zh-Hans", "zh-Hant"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "locale";

export function isLocale(value: string | undefined): value is Locale {
  return (LOCALES as readonly string[]).includes(value ?? "");
}
