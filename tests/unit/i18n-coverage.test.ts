import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DICTIONARIES, translateServerMessage } from "@/shared/i18n";
import { en, type MessageKey } from "@/shared/i18n/messages/en";

/**
 * Nothing a person reads may silently fall back to English. These checks cover every module, not one area:
 * every screen text has a real Hinglish and Hindi version (not a copy of the English), and every fixed message the
 * server can send (errors, validation, refusals) has a translation, so a new message without one fails here.
 */

const SRC = join(process.cwd(), "src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
const files = walk(SRC);
const rel = (file: string) => file.slice(SRC.length + 1).replace(/\\/g, "/");
const strip = (text: string) => text.replace(/\{\w+\}/g, "");
const hasWords = (text: string) => /[A-Za-z]{3,}/.test(strip(text));

/** Reviewed exceptions: loan words and formats that stay the same in Hinglish, and values with no Hindi words. */
const BASELINE = JSON.parse(readFileSync(join(process.cwd(), "tests", "unit", "i18n-same-as-english.json"), "utf8")) as { hinglishSameAsEnglish: string[]; hindiLatinOnly: string[] };

describe("screen text: every key has real Hinglish and Hindi", () => {
  const keys = Object.keys(en) as MessageKey[];

  it("no Hinglish text is a copy of the English, except the reviewed loan words", () => {
    const allowed = new Set(BASELINE.hinglishSameAsEnglish);
    const copies = keys.filter((key) => hasWords(en[key]) && DICTIONARIES.hinglish[key] === en[key] && !allowed.has(key));
    expect(copies, `Hinglish copies the English for: ${copies.join(", ")}`).toEqual([]);
    // The reviewed list stays honest: a key that has since been translated must leave it.
    const stale = [...allowed].filter((key) => !(key in en) || DICTIONARIES.hinglish[key as MessageKey] !== en[key as MessageKey]);
    expect(stale, `No longer the same as English (remove from the reviewed list): ${stale.join(", ")}`).toEqual([]);
  });

  it("no Hindi text is missing Devanagari when the English has words", () => {
    const allowed = new Set(BASELINE.hindiLatinOnly);
    const latinOnly = keys.filter((key) => hasWords(en[key]) && !/[ऀ-ॿ]/.test(DICTIONARIES.hi[key]) && !allowed.has(key));
    expect(latinOnly, `Hindi has no Devanagari for: ${latinOnly.join(", ")}`).toEqual([]);
  });

  it("every key used on a screen exists, so a typo cannot show a bare key", () => {
    const used = new Set<string>();
    for (const file of files) {
      if (rel(file).startsWith("shared/i18n/")) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bt\(\s*"([a-z][A-Za-z0-9_.]*\.[A-Za-z0-9_.]+)"/g)) used.add(match[1]!);
    }
    expect(used.size).toBeGreaterThan(300);
    const missing = [...used].filter((key) => !(key in en));
    expect(missing, `Keys used on screens but not defined: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("server messages: every fixed message has a Hindi and a Hinglish translation", () => {
  // The places user-facing text is written on the server: service errors, validation and shared rules.
  const SERVER_FILES = files.filter((file) => {
    const path = rel(file);
    if (path.startsWith("shared/i18n/") || path.startsWith("components/") || path.startsWith("config/")) return false;
    if (/^app\/.*\.tsx$/.test(path)) return false;
    return /^(modules|server|shared)\//.test(path) || /^app\/.*actions\.ts$/.test(path);
  });

  /**
   * Messages only a developer or an operator can see: internal accounting guard rails that the screens prevent, the API header check,
   * start-up configuration and provider diagnostics. They are not shown to a shop user, so they stay in English by design.
   */
  const OPERATOR_ONLY: [file: RegExp, why: string][] = [
    [/^shared\/accounting\.ts$/, "internal journal invariants; the screens never offer an input that breaks them"],
    [/^modules\/sync\/idempotency\.ts$/, "API header check, not a screen"],
    [/^server\/env\.ts$/, "start-up configuration"],
    [/^modules\/identity\/otp-provider\.ts$/, "operator configuration"],
    [/^modules\/reporting\/reminder-provider\.ts$/, "provider diagnostics for the operator"],
  ];
  // The two accounting rules a shop user can reach through the bank screens are translated, so they are not exempt.
  const REACHABLE = /bank paid more than|There is no difference to add/;

  /** Every text a template can produce: a `${x ? "a" : "b"}` choice gives one message per branch, other values become a stand-in. */
  const variants = (raw: string): string[] => {
    const parts = [...raw.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    let results = [raw];
    for (const part of parts) {
      const inner = part[1]!;
      let options: string[];
      if (inner.includes("formatPaise") || inner.includes("money(")) options = ["₹1.00"];
      else if (/\s\?\s[^?]/.test(inner)) {
        // A choice between pieces of text: every quoted result is a variant (the quoted values being compared are not).
        options = [...inner.matchAll(/"([^"]*)"/g)].filter((match) => !/[=!]==?\s*$/.test(inner.slice(0, match.index))).map((match) => match[1]!);
        if (!/:\s*"[^"]*"\s*$/.test(inner)) options.push("X");
      } else options = ["X"];
      // An empty piece would leave a doubled space no translation can match; such a message always has a value in practice.
      options = [...new Set(options.map((option) => option || "X"))];
      results = results.flatMap((text) => options.map((option) => text.replace(part[0], () => option)));
    }
    return results;
  };

  const PATTERN = /(?:Error\(\s*(?:"[A-Z_0-9]+",\s*)?|\.(?:min|max|length)\(\s*\d+,\s*|\.refine\([^\n]*?,\s*|message:\s*)(["`])((?:(?!\1)[^\\\n])+)\1/g;

  it("covers messages across all modules", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of SERVER_FILES) {
      const path = rel(file);
      const exempt = OPERATOR_ONLY.some(([pattern]) => pattern.test(path));
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(PATTERN)) {
        const raw = match[2]!;
        if (exempt && !REACHABLE.test(raw)) continue;
        // A template that stops inside a nested template cannot be rebuilt here; its pieces are checked where they are written whole.
        if ((raw.match(/\$\{/g) ?? []).length !== (raw.match(/\}/g) ?? []).length) continue;
        for (const text of variants(raw)) {
          // Only sentences people read: they start with a capital letter and are not codes, paths or identifiers.
          if (!/^[A-Z][a-z]/.test(text) || !/\s/.test(text)) continue;
          checked += 1;
          for (const language of ["hi", "hinglish"] as const) {
            if (translateServerMessage(text, language) === text) missing.push(`[${language}] ${path}: ${text}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
    expect(missing, `Untranslated server messages (${missing.length}):\n${missing.slice(0, 200).join("\n")}`).toEqual([]);
  });
});
