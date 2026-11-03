import type { GuidedStep } from "@/shared/guidance";
import type { MessageKey } from "@/shared/i18n/messages/en";

/**
 * The part of a step's check that only reads the page. Anything that needs a form's rules lives in guide-rules.ts, which
 * is loaded on demand, so the validation library is not part of every signed-in page.
 */

export type StepCheck = { ready: boolean; problem: MessageKey | null };

/** The screen is showing a message of its own that the person has to deal with first. */
export const SCREEN_MESSAGE = "guide.ui.fixErrors" satisfies MessageKey;

const has = (selector: string | undefined) => !!selector && !!document.querySelector(selector);

/** Null when the step needs a form's rules to be judged. */
export function lightCheck(step: GuidedStep): StepCheck | null {
  const { done } = step;
  if (done.kind === "view") return { ready: true, problem: null };
  if (done.kind === "present") {
    const invalid = has(done.invalid);
    return {
      ready: !invalid && has(done.selector) && (!done.needs || has(done.needs)),
      problem: invalid ? SCREEN_MESSAGE : null,
    };
  }
  if (done.kind === "saved" || done.kind === "result") return { ready: false, problem: null };
  return null;
}
