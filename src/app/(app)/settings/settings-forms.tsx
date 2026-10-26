"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addStaffAction, setPinAction, setStaffActiveAction, type FormState } from "./actions";

const fieldClass = "flex flex-col gap-2 text-sm font-medium text-foreground";

function Submit({ children, variant = "default" }: { children: React.ReactNode; variant?: "default" | "outline" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="touch" variant={variant} disabled={pending}>
      {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}

function FormMessage({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="flex gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
        <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {state.message}
      </p>
    );
  }
  return null;
}

export function AddStaffForm() {
  const [state, action] = useActionState(addStaffAction, {});
  return (
    <form key={state.nonce} action={action} className="grid gap-4 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto] sm:items-end">
      <label className={fieldClass}>
        Name
        <Input name="name" required maxLength={80} autoComplete="off" className="h-11" />
      </label>
      <label className={fieldClass}>
        Mobile number
        <Input name="phone" required type="tel" inputMode="numeric" maxLength={10} className="h-11" />
      </label>
      <label className={fieldClass}>
        Role
        <select name="role" defaultValue="cashier" className="h-11 rounded-lg border border-input bg-background px-3 text-sm text-foreground">
          <option value="cashier">Cashier</option>
          <option value="inventory">Inventory staff</option>
          <option value="manager">Manager</option>
        </select>
      </label>
      <Submit>Add person</Submit>
      <div className="sm:col-span-4">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function StaffActiveToggle({ userId, active, name }: { userId: string; active: boolean; name: string }) {
  const [state, action] = useActionState(setStaffActiveAction, {});
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <Submit variant="outline">{active ? `Deactivate` : `Reactivate`}<span className="sr-only"> {name}</span></Submit>
      {state.error ? (
        <span role="alert" className="text-xs text-danger">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

export function PinForm({ pinSet }: { pinSet: boolean }) {
  const [state, action] = useActionState(setPinAction, {});
  return (
    <form key={state.nonce} action={action} className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <label className={fieldClass}>
        {pinSet ? "New PIN" : "PIN"}
        <Input name="pin" type="password" inputMode="numeric" autoComplete="new-password" minLength={4} maxLength={6} required className="h-11 tracking-widest" />
      </label>
      <label className={fieldClass}>
        Type it again
        <Input name="confirmPin" type="password" inputMode="numeric" autoComplete="new-password" minLength={4} maxLength={6} required className="h-11 tracking-widest" />
      </label>
      <Submit>{pinSet ? "Change PIN" : "Set PIN"}</Submit>
      <div className="sm:col-span-3">
        <FormMessage state={state} />
      </div>
    </form>
  );
}
