"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setupAction, type SetupState } from "./actions";

/** GST state codes. */
const STATES: [string, string][] = [
  ["01", "Jammu & Kashmir"], ["02", "Himachal Pradesh"], ["03", "Punjab"], ["04", "Chandigarh"], ["05", "Uttarakhand"],
  ["06", "Haryana"], ["07", "Delhi"], ["08", "Rajasthan"], ["09", "Uttar Pradesh"], ["10", "Bihar"], ["11", "Sikkim"],
  ["12", "Arunachal Pradesh"], ["13", "Nagaland"], ["14", "Manipur"], ["15", "Mizoram"], ["16", "Tripura"], ["17", "Meghalaya"],
  ["18", "Assam"], ["19", "West Bengal"], ["20", "Jharkhand"], ["21", "Odisha"], ["22", "Chhattisgarh"], ["23", "Madhya Pradesh"],
  ["24", "Gujarat"], ["26", "Dadra & Nagar Haveli and Daman & Diu"], ["27", "Maharashtra"], ["29", "Karnataka"], ["30", "Goa"],
  ["31", "Lakshadweep"], ["32", "Kerala"], ["33", "Tamil Nadu"], ["34", "Puducherry"], ["35", "Andaman & Nicobar Islands"],
  ["36", "Telangana"], ["37", "Andhra Pradesh"], ["38", "Ladakh"],
];

const fieldClass = "flex flex-col gap-2 text-sm font-medium text-foreground";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="touch" className="w-full" disabled={pending}>
      {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
      {pending ? "Setting up…" : "Create shop and owner"}
    </Button>
  );
}

export function SetupForm() {
  const [state, formAction] = useActionState<SetupState, FormData>(setupAction, {});
  const v = state.values;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Set up your shop</h2>
        <p className="text-muted-foreground">This runs once. You&apos;ll need the setup token from the server&apos;s environment settings.</p>
      </div>

      <form action={formAction} className="grid gap-4 sm:grid-cols-2">
        <label className={`${fieldClass} sm:col-span-2`}>
          Shop name
          <Input name="shopName" defaultValue={v?.shopName} required maxLength={120} placeholder="Sharma Sanitary & Hardware" className="h-11" />
        </label>
        <label className={fieldClass}>
          State
          <select
            name="stateCode"
            defaultValue={v?.stateCode || "08"}
            className="h-11 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          >
            {STATES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldClass}>
          <span>
            GSTIN <span className="font-normal text-muted-foreground">(optional)</span>
          </span>
          <Input name="gstin" defaultValue={v?.gstin} maxLength={15} placeholder="08ABCDE1234F1Z5" className="h-11 uppercase" />
        </label>
        <label className={fieldClass}>
          Owner&apos;s name
          <Input name="ownerName" defaultValue={v?.ownerName} required maxLength={80} autoComplete="name" className="h-11" />
        </label>
        <label className={fieldClass}>
          Owner&apos;s mobile number
          <Input name="ownerPhone" defaultValue={v?.ownerPhone} required type="tel" inputMode="numeric" maxLength={10} autoComplete="tel-national" placeholder="98290 12345" className="h-11" />
        </label>
        <label className={`${fieldClass} sm:col-span-2`}>
          Setup token
          <Input name="setupToken" type="password" required autoComplete="off" spellCheck={false} className="h-11 font-mono" />
          <span className="text-xs font-normal text-muted-foreground">The SETUP_TOKEN value from the server&apos;s .env file. It is checked on the server and never stored.</span>
        </label>

        {state.error ? (
          <p role="alert" className="flex gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger sm:col-span-2">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {state.error}
          </p>
        ) : null}

        <div className="sm:col-span-2">
          <SubmitButton />
        </div>
      </form>
    </div>
  );
}
