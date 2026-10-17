// Escape closes the thing on top, and only that.
//
// Every panel used to add its own window listener, and some never did, so
// Escape either did nothing or closed two layers at once (a panel and the
// Settings page under it). One listener and a stack: the most recently
// opened surface that asked for Escape gets it. A Radix menu, popover or
// dialog handles its own Escape and is left to it.
import { useEffect, useRef } from "react";

const stack: Array<{ current: () => void }> = [];

/** A Radix menu, dialog or popover that is open and hears Escape itself. */
const RADIX_OPEN = '[role=menu], [role=dialog][data-state="open"], [data-radix-popper-content-wrapper]';

/**
 * Whether Escape already has something to close: a surface on the stack,
 * or a menu, dialog or popover that hears the key on its own. The
 * composer asks before it takes Escape to mean "stop the agent" (GitHub
 * 258), so the key still closes what is on top first and stops nothing
 * by surprise. The sidebar's menus hear Escape themselves without being
 * on the stack, and anything drawn as a dialog is on top whether or not
 * the key closes it, so both are named here.
 */
export function escapeTaken(): boolean {
  return stack.length > 0 || Boolean(document.querySelector(`${RADIX_OPEN}, [role=dialog], [data-bot-menu], [data-lane-menu]`));
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (document.querySelector(RADIX_OPEN)) {
    return;
  }
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.current();
}

if (typeof window !== "undefined") window.addEventListener("keydown", onKey);

export function useEscape(close: () => void, enabled = true) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!enabled) return;
    stack.push(latest);
    return () => {
      const at = stack.lastIndexOf(latest);
      if (at >= 0) stack.splice(at, 1);
    };
  }, [enabled]);
}
