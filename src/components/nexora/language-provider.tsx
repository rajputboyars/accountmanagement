"use client";

import { createContext, useContext, useEffect, useMemo } from "react";
import { DEFAULT_LANGUAGE, LANGUAGE_LOCALES, type Language } from "@/shared/i18n/languages";
import { en, type Messages } from "@/shared/i18n/messages/en";
import { makeTranslate, type Translate } from "@/shared/i18n/translate";

const LanguageContext = createContext<{ language: Language; messages: Messages }>({ language: DEFAULT_LANGUAGE, messages: en });

/** Gives client components the person's dictionary. The server passes only that one, so the others aren't downloaded. */
export function LanguageProvider({ language, messages, children }: { language: Language; messages: Messages; children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = LANGUAGE_LOCALES[language].html;
    return () => {
      document.documentElement.lang = LANGUAGE_LOCALES[DEFAULT_LANGUAGE].html;
    };
  }, [language]);
  const value = useMemo(() => ({ language, messages }), [language, messages]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): Language {
  return useContext(LanguageContext).language;
}

/** Translator for client components: `const t = useT();`. Server components use `await getT()`. */
export function useT(): Translate {
  const { messages } = useContext(LanguageContext);
  return useMemo(() => makeTranslate(messages), [messages]);
}
