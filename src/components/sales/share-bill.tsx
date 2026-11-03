"use client";

import { useState, useTransition } from "react";
import { Copy, LoaderCircle, MessageCircle } from "lucide-react";
import { prepareBillMessageAction } from "@/app/(app)/billing/actions";
import { saveCustomerLanguageAction } from "@/app/(app)/customers/actions";
import { selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { isLanguage, LANGUAGE_NAMES, LANGUAGES, type Language } from "@/shared/i18n/languages";

/**
 * Shares a bill summary from the person's own WhatsApp. The controls follow the staff member's language; the
 * message follows the customer's. With no saved language (and always for a walk-in) the person must choose one
 * first: the staff member's own language is never assumed. The message is prepared on the server from the saved
 * bill and nothing is sent until they press send in WhatsApp, so this never claims a message was delivered.
 */
export function ShareBill({ invoiceId, phone, customer, canSaveLanguage }: { invoiceId: string; phone: string | null; customer: { id: string; name: string; language: Language | null } | null; canSaveLanguage: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<Language | null>(customer?.language ?? null);
  const [language, setLanguage] = useState<Language | "">(customer?.language ?? "");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const prepare = (chosen: Language) =>
    start(async () => {
      setText("");
      setCopied(false);
      setError(null);
      setNote(null);
      const result = await prepareBillMessageAction(invoiceId, chosen);
      if (result.text) setText(result.text);
      else setError(result.error ?? t("share.failed"));
    });

  const saveLanguage = () => {
    if (!customer || !language) return;
    start(async () => {
      const result = await saveCustomerLanguageAction(customer.id, language);
      if (result.ok) {
        setSaved(language);
        setNote(t("share.languageSaved", { name: customer.name }));
      } else setError(result.error ?? t("share.failed"));
    });
  };

  const digits = phone?.replace(/\D/g, "").slice(-10) ?? "";
  const link = `https://wa.me/${digits.length === 10 ? `91${digits}` : ""}?text=${encodeURIComponent(text)}`;

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="touch"
        onClick={() => {
          setOpen(true);
          if (language) prepare(language);
        }}
      >
        <MessageCircle aria-hidden="true" />
        WhatsApp
      </Button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-border bg-card p-3 sm:max-w-md">
      <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
        {t("share.language")}
        <select
          value={language}
          disabled={pending}
          onChange={(event) => {
            const value = event.target.value;
            if (!isLanguage(value)) return;
            setLanguage(value);
            prepare(value);
          }}
          className={selectClass}
        >
          {language ? null : <option value="">{t("share.chooseLanguage")}</option>}
          {LANGUAGES.map((option) => (
            <option key={option} value={option}>
              {LANGUAGE_NAMES[option]}
            </option>
          ))}
        </select>
        <span className="text-xs font-normal text-muted-foreground">{saved && customer ? t("share.savedHelp", { name: customer.name }) : t("share.chooseHelp")}</span>
      </label>
      {customer && canSaveLanguage && language && language !== saved ? (
        <Button type="button" variant="outline" size="sm" className="self-start" disabled={pending} onClick={saveLanguage}>
          {t("share.saveLanguage", { name: customer.name })}
        </Button>
      ) : null}
      {note ? (
        <p role="status" className="text-xs text-success">
          {note}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {pending && !text ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {t("share.preparing")}
        </p>
      ) : null}
      {text ? (
        <>
          <p className="text-sm font-medium text-foreground">{t("share.ready")}</p>
          <pre className="rounded-lg bg-muted/60 p-3 font-sans text-sm whitespace-pre-wrap text-foreground">{text}</pre>
          <div className="flex flex-wrap gap-2">
            <a href={link} target="_blank" rel="noreferrer" className={buttonVariants({ size: "touch" })}>
              <MessageCircle className="size-4" aria-hidden="true" />
              {t(digits.length === 10 ? "share.openChat" : "share.chooseChat")}
            </a>
            <Button type="button" variant="outline" size="touch" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}>
              <Copy aria-hidden="true" />
              {t(copied ? "share.copied" : "share.copy")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("share.note")}</p>
        </>
      ) : null}
    </div>
  );
}
