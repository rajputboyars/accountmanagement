import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DICTIONARIES, translateServerMessage } from "@/shared/i18n";
import { en, type MessageKey } from "@/shared/i18n/messages/en";

/**
 * A server message can carry a value the system itself chose (the name of a field, the purpose of a unit, an approval status). Those are
 * translated with the sentence; anything a person typed (a product, customer or note) is left exactly as written.
 */

const hindi = (key: MessageKey) => DICTIONARIES.hi[key];
const hinglish = (key: MessageKey) => DICTIONARIES.hinglish[key];

describe("system-generated values inside server messages", () => {
  const LABELS = (Object.keys(en) as MessageKey[]).filter((key) => key.startsWith("label.field."));
  const TEMPLATES: MessageKey[] = ["server.enterLabel", "server.chooseLabel", "server.labelAmountShape", "server.labelAboveZero", "server.enterLabelRupeesAbove0", "server.enterLabelRupeesExample", "server.enterLabelRupeesExample2", "server.chooseValidLabelDate", "server.chooseUnitFromList"];

  it("no known field label is left in English inside a translated validation message", () => {
    const leaks: string[] = [];
    for (const labelKey of LABELS) {
      for (const template of TEMPLATES) {
        const message = en[template].replace(/{(?:label|purpose)}/, en[labelKey]);
        for (const language of ["hi"] as const) {
          const translated = translateServerMessage(message, language);
          const sameWord = DICTIONARIES[language][labelKey].toLowerCase() === en[labelKey].toLowerCase();
          // A sentence a language keeps in English on purpose is covered by the reviewed list in i18n-same-as-english.json.
          if (translated !== message && !sameWord && translated.toLowerCase().includes(en[labelKey].toLowerCase())) leaks.push(`[${language}] ${message}`);
        }
      }
    }
    expect(leaks, leaks.slice(0, 20).join(" | ")).toEqual([]);
  });

  it("uses the dictionary wording for the label, whatever its capital letters", () => {
    expect(translateServerMessage("Enter the customer.", "hi")).toContain(hindi("label.field.customer"));
    expect(translateServerMessage("Enter the UPI amount.", "hinglish")).toContain(hinglish("label.field.upiAmount"));
    expect(translateServerMessage("Enter the Minimum Quantity.", "hi")).toContain(hindi("label.field.minimumQuantity"));
    expect(translateServerMessage("Choose a valid start date.", "hinglish")).toContain(hinglish("label.field.start"));
    expect(translateServerMessage("Choose a valid as-at date.", "hi")).toContain(hindi("label.field.asAt"));
  });

  it("translates an approval status in the sentence", () => {
    expect(translateServerMessage("This request was already pending.", "hi")).toContain(hindi("approvals.status.pending"));
    expect(translateServerMessage("This request was already pending.", "hinglish")).toContain(hinglish("approvals.status.pending"));
    // The statuses that have their own wording keep it.
    for (const status of ["approved", "rejected", "expired"] as const) expect(translateServerMessage(`This request was already ${status}.`, "hi")).toMatch(/[ऀ-ॿ]/);
  });

  it("leaves names and text a person typed exactly as written, even when they look like a label", () => {
    const message = "Only 3 pc of Special price pipe can be delivered from here (the rest is on hand but set aside for other orders, or not in stock).";
    const translated = translateServerMessage(message, "hi");
    expect(translated).toContain("Special price pipe");
    // A product that is literally called "amount" or "Approved" stays that way: only the label, purpose and status slots are translated.
    expect(translateServerMessage("Only 3 pc of amount can be delivered from here (the rest is on hand but set aside for other orders, or not in stock).", "hi")).toContain("amount");
    expect(translateServerMessage("Only 3 pc of Approved can be delivered from here (the rest is on hand but set aside for other orders, or not in stock).", "hi")).toContain("Approved");
  });

  it("an unknown label stays as written rather than being guessed", () => {
    expect(translateServerMessage("Enter the gadget size.", "hi")).toContain("gadget size");
  });

  it("every label the server code writes into a message has a translation", () => {
    const SRC = join(process.cwd(), "src");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : /\.ts$/.test(name) ? [join(dir, name)] : []));
    const known = new Set((Object.keys(en) as MessageKey[]).filter((key) => key.startsWith("label.field.")).map((key) => en[key].toLowerCase()));
    const used = new Set<string>();
    for (const file of walk(join(SRC, "modules"))) {
      const source = readFileSync(file, "utf8");
      // The label helpers (rupees, uuid, quantity) are defined in the validation files and in the cashbook service.
      if (/validation\.ts$|cashbook[\\/]service\.ts$/.test(file)) {
        for (const match of source.matchAll(/\b(?:rupees|uuid|quantity)\(\s*"([^"]+)"/g)) used.add(match[1]!.toLowerCase());
      }
      for (const match of source.matchAll(/checkDate\([^,()]+,\s*"([^"]+)"\)/g)) used.add(match[1]!.toLowerCase());
      for (const match of source.matchAll(/requireActiveUnit\([^)]*,\s*"([^"]+)"\)/g)) used.add(match[1]!.toLowerCase());
    }
    expect(used.size).toBeGreaterThan(10);
    // A helper given a whole sentence (not a label) is checked by the server-message test instead.
    const missing = [...used].filter((label) => !label.endsWith(".") && !known.has(label));
    expect(missing, `Labels with no translation (add a label.field.* entry): ${missing.join(", ")}`).toEqual([]);
  });
});
