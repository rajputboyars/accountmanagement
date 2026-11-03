"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { confirmGuideSavedAction, pauseGuideAction, setGuideStepAction, skipGuideAction } from "@/app/(app)/guides/actions";
import { lightCheck, type StepCheck } from "@/components/nexora/guide-page";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { GUIDED_TASKS, stepBodyKey, stepTitleKey, taskTitleKey, type GuidedStep, type GuidedTaskKey } from "@/shared/guidance";
import type { MessageKey } from "@/shared/i18n/messages/en";

type Rules = typeof import("@/components/nexora/guide-rules");
let loadedRules: Rules | null = null;
let loadingRules: Promise<Rules> | null = null;
/** The forms' validation rules are fetched the first time a step needs them, so ordinary pages never download them. */
function loadRules(): Promise<Rules> {
  loadingRules ??= import("@/components/nexora/guide-rules").then(
    (module) => (loadedRules = module),
    (error) => {
      loadingRules = null;
      throw error;
    },
  );
  return loadingRules;
}
const needsRules = (step: GuidedStep | undefined) => step?.done.kind === "fields" || step?.done.kind === "receipt";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isTyping = (element: Element | null) => !!element?.matches("input,select,textarea");
const focusable = (target: HTMLElement) => (target.matches("input,select,textarea,button") ? target : (target.querySelector<HTMLElement>("input,select,textarea,button") ?? target));

/**
 * Walks a person through the real screens. It highlights one thing and reads the page; it never fills, clicks or submits
 * anything, and nothing covers the page with a blocking layer. Next stays off until the step's real state is met.
 */
export function GuidedTaskRunner({ active }: { active: { key: GuidedTaskKey; step: number } | null }) {
  const t = useT();
  const pathname = usePathname();
  const [run, setRun] = useState(active);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [found, setFound] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [box, setBox] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [rules, setRules] = useState<Rules | null>(loadedRules);
  const [rulesFailed, setRulesFailed] = useState(false);
  const [settledKey, setSettledKey] = useState("");
  const atStep = useRef("");
  const panel = useRef<HTMLElement>(null);
  const instruction = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLParagraphElement>(null);
  // Mounted already running means a reload or sign-in: the page keeps its focus. Started here means the person asked for it.
  const openedHere = useRef(!active);
  const returnTo = useRef<Element | null>(null);
  const lastSeen = useRef("");

  // The server is the record of progress: a refresh, sign-in or another device brings it back.
  const activeId = active ? `${active.key}:${active.step}` : "";
  const [seenId, setSeenId] = useState(activeId);
  if (activeId !== seenId) {
    setSeenId(activeId);
    // The save's own refresh reports nothing running: the confirmation stays until the person has read it.
    const confirming = !active && run && GUIDED_TASKS[run.key].steps[run.step]?.done.kind === "result";
    if (!confirming) setRun(active);
  }

  const steps = run ? GUIDED_TASKS[run.key].steps : [];
  const step = run ? steps[run.step] : undefined;
  const onScreen = !!step && new RegExp(step.path).test(pathname);
  useEffect(() => {
    atStep.current = run ? `${run.key}:${run.step}` : "";
  }, [run]);

  // The rules for this step's form arrive the first time they are needed; if they can't, the screen's own checks still stand at save.
  const checksNeeded = needsRules(step);
  useEffect(() => {
    if (!checksNeeded || rules) return;
    let live = true;
    loadRules().then(
      (module) => live && (setRules(module), setRulesFailed(false)),
      () => live && setRulesFailed(true),
    );
    return () => {
      live = false;
    };
  }, [checksNeeded, rules]);
  const readStep = useCallback((from: GuidedStep, loaded: Rules | null): StepCheck => lightCheck(from) ?? (loaded ? loaded.checkStep(from) : { ready: rulesFailed, problem: null }), [rulesFailed]);

  // A page is ready to point at once it has loaded and the browser has nothing queued: what was streamed in has finished hydrating.
  const settleKey = step && onScreen ? `${pathname}:${step.id}` : "";
  useEffect(() => {
    if (!settleKey) return;
    let cancelled = false;
    let idle = 0;
    let frame = 0;
    const done = () => !cancelled && setSettledKey(settleKey);
    const settle = () => {
      if ("requestIdleCallback" in window) idle = window.requestIdleCallback(done);
      else frame = requestAnimationFrame(() => (frame = requestAnimationFrame(done)));
    };
    if (document.readyState === "complete") settle();
    else window.addEventListener("load", settle, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", settle);
      if (idle) window.cancelIdleCallback(idle);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [settleKey]);
  const settled = settleKey !== "" && settledKey === settleKey;

  // Watches the live page while the step is open. It only reads the page: the highlight is drawn by this component, never put on the page's own elements.
  useEffect(() => {
    if (!step || !onScreen) return;
    let frame = 0;
    let lastKey = "";
    let nudges = 0;
    let watched: Element | null = null;
    const look = () => {
      frame = 0;
      const check = readStep(step, rules);
      setReady(check.ready);
      setProblem(check.problem);
      const element = step.target ? document.querySelector(step.target) : null;
      const rect = element?.getBoundingClientRect();
      // Present and taking up room: a hidden or not-yet-drawn target counts as not there.
      const target = element && rect && rect.width > 0 && rect.height > 0 ? element : null;
      setFound(!step.target || !!target);
      setHasError(!!document.querySelector('main [role="alert"], main form .text-danger'));
      if (target !== watched) {
        if (watched) resizer.unobserve(watched);
        if (target) resizer.observe(target);
        watched = target;
      }
      if (target && settled) {
        const key = `${pathname}:${step.id}`;
        if (key !== lastKey) {
          lastKey = key;
          // After a frame, once the room for the phone sheet has been added to the page.
          requestAnimationFrame(() => {
            // Just under the sticky header, which leaves short phones the most room above the sheet.
            const header = document.querySelector("header")?.getBoundingClientRect().bottom ?? 64;
            const top = target.getBoundingClientRect().top + window.scrollY - header - 12;
            window.scrollTo({
              top: Math.max(0, top),
              behavior: reducedMotion() || window.innerWidth < 768 ? "auto" : "smooth",
            });
          });
        }
        // The sheet may have grown after the first scroll: a few small corrections keep the target clear of it.
        const sheetTop = panel.current?.getBoundingClientRect().top ?? window.innerHeight;
        const bottom = target.getBoundingClientRect().bottom;
        if (window.innerWidth < 768 && bottom > sheetTop - 8 && nudges < 3 && target.getBoundingClientRect().height < sheetTop - 72) {
          nudges += 1;
          window.scrollBy({ top: bottom - sheetTop + 16, behavior: "auto" });
        }
        const now = target.getBoundingClientRect();
        setBox((old) =>
          old && Math.abs(old.top - now.top) < 0.5 && Math.abs(old.left - now.left) < 0.5 && Math.abs(old.width - now.width) < 0.5 && Math.abs(old.height - now.height) < 0.5
            ? old
            : {
                top: now.top,
                left: now.left,
                width: now.width,
                height: now.height,
              },
        );
        place(target);
      } else {
        setBox(null);
        setPosition(null);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(look);
    };
    const place = (target: Element) => {
      const width = panel.current?.offsetWidth ?? 320;
      const height = panel.current?.offsetHeight ?? 220;
      if (window.innerWidth < 768) return setPosition(null);
      const box = target.getBoundingClientRect();
      const left = box.right + 16 + width <= window.innerWidth - 8 ? box.right + 16 : box.left - 16 - width >= 8 ? box.left - 16 - width : null;
      if (left === null) {
        // Too wide for a neighbour: sit above or below it instead, so the highlighted thing stays clear.
        const under = box.bottom + 12 + height <= window.innerHeight - 8;
        const over = box.top - 12 - height >= 8;
        const tall = !under && !over;
        const top = tall ? window.innerHeight - height - 8 : under ? box.bottom + 12 : box.top - 12 - height;
        const side = window.innerWidth - width - 16;
        return setPosition((old) => (old && Math.abs(old.top - top) < 1 && Math.abs(old.left - side) < 1 ? old : { top, left: side }));
      }
      const top = Math.min(Math.max(8, box.top), window.innerHeight - height - 8);
      setPosition((old) => (old && Math.abs(old.top - top) < 1 && Math.abs(old.left - left) < 1 ? old : { top, left }));
    };
    // Changes on the page wake this up; nothing waits on a clock. Changes inside the guide itself are not the page's.
    const resizer = new ResizeObserver(schedule);
    const changes = new MutationObserver((records) => {
      if (records.some((record) => !panel.current?.contains(record.target))) schedule();
    });
    changes.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-invalid", "hidden", "data-guide-synced"],
    });
    if (panel.current) resizer.observe(panel.current);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("input", schedule);
    document.addEventListener("change", schedule);
    document.addEventListener("focusout", schedule);
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizer.disconnect();
      changes.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("input", schedule);
      document.removeEventListener("change", schedule);
      document.removeEventListener("focusout", schedule);
    };
  }, [step, onScreen, pathname, rules, readStep, settled]);

  // On a phone the sheet sits over the bottom of the page: leave room so the last field can scroll clear of it.
  const isOpen = !!step;
  useEffect(() => {
    if (!isOpen || !panel.current) return;
    const previous = document.body.style.paddingBottom;
    const fit = () => {
      document.body.style.paddingBottom = window.innerWidth < 768 ? `${(panel.current?.offsetHeight ?? 220) + 96}px` : previous;
    };
    const watcher = new ResizeObserver(fit);
    watcher.observe(panel.current);
    window.addEventListener("resize", fit);
    return () => {
      watcher.disconnect();
      window.removeEventListener("resize", fit);
      document.body.style.paddingBottom = previous;
    };
  }, [isOpen]);

  // A new step takes focus only if focus was already with the guide or lost; someone typing in the form keeps their place and hears it instead.
  const spoken =
    run && step ? `${t(taskTitleKey(run.key))}. ${t("guide.ui.stepOf", { step: run.step + 1, total: steps.length })}. ${t(stepTitleKey(run.key, step.id))}. ${t(stepBodyKey(run.key, step.id))}` : "";
  const seen = run ? `${run.key}:${run.step}:${onScreen}` : "";
  useEffect(() => {
    if (!seen) {
      lastSeen.current = "";
      openedHere.current = true;
      return;
    }
    if (seen === lastSeen.current) return;
    const first = !lastSeen.current;
    lastSeen.current = seen;
    const current = document.activeElement;
    if (first) returnTo.current = current;
    const lost = !current || current === document.body;
    const canMove = first ? openedHere.current && !isTyping(current) : lost || !!panel.current?.contains(current);
    if (canMove) instruction.current?.focus({ preventScroll: true });
    else if (live.current) live.current.textContent = spoken;
  }, [seen, spoken]);

  // F6 moves between the guide and what it points at, so nobody has to tab across the whole page to reach Next.
  const targetSelector = step?.target;
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F6") return;
      event.preventDefault();
      const target = targetSelector ? document.querySelector<HTMLElement>(targetSelector) : null;
      if (panel.current?.contains(document.activeElement) && target) focusable(target).focus();
      else instruction.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, targetSelector]);

  // Waits for the existing workflow to save; the server confirms it from the audit log.
  const waitingSave = step?.done.kind === "saved" ? run?.key : undefined;
  useEffect(() => {
    if (!waitingSave) return;
    let stopped = false;
    const check = async () => {
      const response = await fetch(`/api/guidance/saved?task=${waitingSave}`, {
        cache: "no-store",
      }).catch(() => null);
      const body = response?.ok ? ((await response.json()) as { saved: boolean }) : null;
      if (stopped || !body?.saved) return;
      const next = await confirmGuideSavedAction(waitingSave);
      if (!stopped && next !== null) setRun({ key: waitingSave, step: next });
    };
    // The save happens elsewhere, on the server: this is the one thing here that has to ask on a clock, as nothing tells the page.
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [waitingSave, pathname]);

  const go = useCallback(
    (to: number) => {
      if (!run) return;
      setRun({ key: run.key, step: to });
      void setGuideStepAction(run.key, to);
    },
    [run],
  );

  if (!run || !step) return null;

  // Back to where the person was, or to the page itself when that has gone.
  const leave = () => {
    const back = returnTo.current;
    setRun(null);
    requestAnimationFrame(() => {
      if (back instanceof HTMLElement && back !== document.body && back.isConnected) return back.focus({ preventScroll: true });
      const main = document.getElementById("main");
      main?.setAttribute("tabindex", "-1");
      main?.focus({ preventScroll: true });
    });
  };
  const close = (action: (task: string) => Promise<void>) => {
    leave();
    void action(run.key);
  };
  // Reads the page again, right before moving on: the last look may be older than what was just typed. Nothing waits between that read and the move.
  const tryNext = async () => {
    const from = atStep.current;
    const loaded = rules ?? (needsRules(step) && !rulesFailed ? await loadRules().catch(() => null) : null);
    if (atStep.current !== from) return;
    const check = lightCheck(step) ?? (loaded ? loaded.checkStep(step) : { ready: needsRules(step), problem: null });
    setReady(check.ready);
    setProblem(check.problem);
    if (check.ready) go(run.step + 1);
  };
  const isResult = step.done.kind === "result";
  const isSave = step.done.kind === "saved";
  const showTarget = () => {
    const target = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    if (!target) return;
    focusable(target).focus();
  };

  return (
    <>
      {onScreen && settled && found && box ? (
        <div
          aria-hidden="true"
          data-guide-highlight
          className="pointer-events-none fixed z-30 rounded-lg border-[3px] border-teal print:hidden"
          style={{
            top: box.top - 6,
            left: box.left - 6,
            width: box.width + 12,
            height: box.height + 12,
          }}
        />
      ) : null}
      <aside
        ref={panel}
        aria-label={t(taskTitleKey(run.key))}
        data-guide-panel={run.key}
        data-guide-step={step.id}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (isResult) leave();
          else close(pauseGuideAction);
        }}
        style={position ? { top: position.top, left: position.left } : undefined}
        className={`fixed inset-x-2 bottom-20 z-40 flex max-h-[45dvh] flex-col gap-2 overflow-y-auto rounded-2xl border border-teal/50 bg-popover p-3 text-sm break-words text-popover-foreground shadow-lg md:inset-x-auto md:max-h-[70dvh] md:w-80 md:p-4 print:hidden ${position ? "md:bottom-auto" : "md:right-4 md:bottom-4"}`}
      >
        <p ref={live} role="status" className="sr-only" />
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">
            {t(taskTitleKey(run.key))} · {t("guide.ui.stepOf", { step: run.step + 1, total: steps.length })}
          </p>
          <div
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-valuenow={run.step + 1}
            aria-valuetext={t("guide.ui.stepOf", {
              step: run.step + 1,
              total: steps.length,
            })}
            aria-label={t(taskTitleKey(run.key))}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-teal" style={{ width: `${((run.step + 1) / steps.length) * 100}%` }} />
          </div>
          <div
            ref={instruction}
            tabIndex={-1}
            role="group"
            aria-labelledby="guide-step-title"
            aria-describedby="guide-step-body"
            className="flex flex-col gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <h2 id="guide-step-title" className="flex items-center gap-1.5 font-semibold text-foreground">
              {isResult ? <CircleCheck className="size-4 shrink-0 text-teal" aria-hidden="true" /> : null}
              {t(stepTitleKey(run.key, step.id))}
            </h2>
            <p id="guide-step-body" className="text-muted-foreground">
              {t(stepBodyKey(run.key, step.id))}
            </p>
          </div>
          {!onScreen ? <p className="text-xs text-foreground">{t("guide.ui.openFirst")}</p> : null}
          {onScreen && settled && !found ? <p className="text-xs text-foreground">{step.missing ? t(step.missing.message) : t("guide.ui.notOnScreen")}</p> : null}
          {onScreen && rulesFailed && needsRules(step) ? <p className="text-xs text-foreground">{t("guide.ui.checksUnavailable")}</p> : null}
          <div role="status" className="flex flex-col gap-1 empty:hidden">
            {onScreen && !isResult && problem !== null ? (
              <p id="guide-step-problem" data-guide-problem className="flex gap-1.5 text-xs text-danger">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {t(problem)}
              </p>
            ) : onScreen && !isResult && hasError ? (
              <p className="flex gap-1.5 text-xs text-danger">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {t("guide.ui.fixErrors")}
              </p>
            ) : null}
          </div>
          {onScreen && !isSave && !isResult && !ready && found && problem === null ? (
            <p id="guide-step-need" className="text-xs text-foreground">
              {t("guide.ui.needAction")}
            </p>
          ) : null}
          {isSave && onScreen ? <p className="text-xs text-foreground">{t("guide.ui.waitingSave")}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isResult ? (
            <Button type="button" size="touch" onClick={leave}>
              {t("guide.ui.finish")}
            </Button>
          ) : (
            <>
              {run.step > 0 ? (
                <Button type="button" size="touch" variant="outline" onClick={() => go(run.step - 1)}>
                  {t("guide.ui.previous")}
                </Button>
              ) : null}
              {!onScreen ? (
                <Link
                  href={step.href}
                  className="inline-flex min-h-11 items-center rounded-lg bg-primary px-3 font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {t("guide.ui.openScreen")}
                </Link>
              ) : !isSave ? (
                <Button
                  type="button"
                  size="touch"
                  aria-disabled={!ready}
                  aria-describedby={ready ? undefined : problem !== null ? "guide-step-problem" : "guide-step-need"}
                  className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  onClick={() => void tryNext()}
                >
                  {t("guide.ui.next")}
                </Button>
              ) : null}
              {onScreen && step.target && found ? (
                <Button type="button" size="touch" variant="ghost" onClick={showTarget}>
                  {t("guide.ui.goThere")}
                </Button>
              ) : null}
              {onScreen && settled && step.missing && !found ? (
                <Link
                  href={step.missing.href}
                  className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-teal hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {t("guide.ui.openSuppliers")}
                </Link>
              ) : null}
            </>
          )}
        </div>
        {isResult ? null : (
          <div className="flex items-center gap-3 text-xs">
            <button
              type="button"
              onClick={() => close(pauseGuideAction)}
              className="min-h-8 rounded text-muted-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11"
            >
              {t("guide.ui.exit")}
            </button>
            <button
              type="button"
              onClick={() => close(skipGuideAction)}
              className="min-h-8 rounded text-muted-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11"
            >
              {t("guide.ui.skip")}
            </button>
          </div>
        )}
        <p className="text-xs text-muted-foreground pointer-coarse:hidden">{t("guide.ui.keyboardHint")}</p>
      </aside>
    </>
  );
}
