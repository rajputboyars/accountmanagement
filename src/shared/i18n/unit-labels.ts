import { isMessageKey, type Translate } from "./translate";

/** Safe in client components. Stored unit codes and state codes never change: these only choose what a person reads. */

const UNIT_NAMES: Record<string, string> = { pc: "Piece", box: "Box", bundle: "Bundle", m: "Meter", length: "Length", kg: "Kilogram", bag: "Bag", ltr: "Litre", set: "Set" };

/** A unit's full name. Nexora's starting units are translated; a unit the shop named itself is kept as written. */
export function unitName(t: Translate, code: string, name: string): string {
  const key = `unit.${code}.name`;
  return Object.hasOwn(UNIT_NAMES, code) && UNIT_NAMES[code] === name && isMessageKey(key) ? t(key) : name;
}

/** A unit's short form after a quantity, such as "kg" or "पीस". The saved code is what gets stored and submitted. */
export function unitShort(t: Translate, code: string): string {
  const key = `unit.${code}.short`;
  return isMessageKey(key) ? t(key) : code;
}

/** "Bundle of 10", "10 ka Bundle", "10 का बंडल". */
export function packLabel(t: Translate, code: string, name: string, factor: string): string {
  return t("unit.packOf", { unit: unitName(t, code, name), qty: factor });
}

/** A state's name from its GST code, which is what is stored. */
export function stateName(t: Translate, code: string): string {
  const key = `state.${code}`;
  return isMessageKey(key) ? t(key) : code;
}
