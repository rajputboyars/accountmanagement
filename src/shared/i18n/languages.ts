/** The languages a person can choose. Add a language here and TypeScript asks for its full dictionary. */
export const LANGUAGES = ["en", "hinglish", "hi"] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "en";

/** Each name is written in its own language, so a person can find theirs whatever is showing now. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", hinglish: "Hinglish", hi: "हिन्दी" };

/** `html` is the page's lang attribute; `dates` formats dates (digits stay 0-9 and ₹ grouping is unchanged). */
export const LANGUAGE_LOCALES: Record<Language, { html: string; dates: string }> = {
  en: { html: "en-IN", dates: "en-IN" },
  hinglish: { html: "hi-Latn", dates: "en-IN" },
  hi: { html: "hi", dates: "hi-IN" },
};

export function isLanguage(value: unknown): value is Language {
  return (LANGUAGES as readonly unknown[]).includes(value);
}

/** Anything unknown or missing falls back to the default language. */
export function normalizeLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}
