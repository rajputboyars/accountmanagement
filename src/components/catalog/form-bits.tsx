"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

export const selectClass =
  "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground aria-invalid:border-destructive";
export const textareaClass =
  "min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground aria-invalid:border-destructive";

/**
 * A select that keeps its value after a rejected submit. React resets forms after an action, and
 * an uncontrolled select's defaultValue does not survive that reset, so this one is controlled.
 */
export function FormSelect({ defaultValue = "", ...props }: Omit<React.ComponentProps<"select">, "value" | "defaultValue"> & { defaultValue?: string }) {
  const [value, setValue] = useState(defaultValue);
  const ref = useRef<HTMLSelectElement>(null);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    // The reset event fires before the browser resets the fields, so restore on the next tick.
    const restore = () => queueMicrotask(() => ref.current && (ref.current.value = valueRef.current));
    form.addEventListener("reset", restore);
    return () => form.removeEventListener("reset", restore);
  }, []);
  return <select {...props} ref={ref} value={value} onChange={(event) => setValue(event.target.value)} className={cn(selectClass, props.className)} />;
}

export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5 text-sm font-medium text-foreground", className)}>
      {label}
      {children}
      {error ? (
        <span className="text-xs font-normal text-danger">{error}</span>
      ) : hint ? (
        <span className="text-xs font-normal text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

export function FormAlert({ error, message }: { error?: string; message?: string }) {
  if (error) {
    return (
      <p role="alert" className="flex gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {error}
      </p>
    );
  }
  if (message) {
    return (
      <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
        <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {message}
      </p>
    );
  }
  return null;
}

export function SubmitButton({ children, variant = "default", className }: { children: React.ReactNode; variant?: "default" | "outline" | "destructive"; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="touch" variant={variant} disabled={pending} className={className}>
      {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}
