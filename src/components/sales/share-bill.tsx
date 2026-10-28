"use client";

import { useState } from "react";
import { Copy, MessageCircle } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * Shares a bill summary from the person's own WhatsApp. The message is prepared here and nothing is
 * sent until they press send in WhatsApp, so this never claims a message was delivered.
 */
export function ShareBill({ text, phone }: { text: string; phone: string | null }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const digits = phone?.replace(/\D/g, "").slice(-10) ?? "";
  const link = `https://wa.me/${digits.length === 10 ? `91${digits}` : ""}?text=${encodeURIComponent(text)}`;
  if (!open) {
    return (
      <Button type="button" variant="outline" size="touch" onClick={() => setOpen(true)}>
        <MessageCircle aria-hidden="true" />
        WhatsApp
      </Button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-border bg-card p-3 sm:max-w-md">
      <p className="text-sm font-medium text-foreground">Message ready to send</p>
      <pre className="rounded-lg bg-muted/60 p-3 text-sm whitespace-pre-wrap text-foreground">{text}</pre>
      <div className="flex flex-wrap gap-2">
        <a href={link} target="_blank" rel="noreferrer" className={buttonVariants({ size: "touch" })}>
          <MessageCircle className="size-4" aria-hidden="true" />
          {digits.length === 10 ? "Open WhatsApp chat" : "Choose chat in WhatsApp"}
        </a>
        <Button type="button" variant="outline" size="touch" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}>
          <Copy aria-hidden="true" />
          {copied ? "Copied" : "Copy text"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Nothing is sent from Nexora. WhatsApp opens with this message; it goes only when you press send there.</p>
    </div>
  );
}
