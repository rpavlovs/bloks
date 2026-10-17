import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Keeps a row where it is on screen while the page above it changes
 * height on its own: a turn ends and its work folds into one line
 * (src/lib/turnFold.ts), and the reply under it must not jump.
 *
 * A reader at the end of the conversation is already held there
 * (useStickToBottom), so this is for the one who scrolled away. The row
 * is measured while the change is being rendered, when the page still
 * shows what it showed, and put back where it was before anything is
 * painted. `change` is what says the page folded, `selector` finds the
 * row to hold, and without one the distance to the end is held instead.
 * Another conversation (`scope`) is another page, and nothing is held
 * across the two.
 */
export function useHoldPlace(
  scrollRef: RefObject<HTMLElement | null>,
  pinned: RefObject<boolean>,
  scope: string,
  change: string,
  selector: string | null,
) {
  const drawn = useRef({ scope, change });
  const before = useRef<{ selector: string | null; top: number | null; fromEnd: number } | null>(null);
  before.current = null;
  if (drawn.current.scope === scope && drawn.current.change !== change) {
    const el = scrollRef.current;
    if (el && !pinned.current) {
      const row = selector ? el.querySelector(selector) : null;
      before.current = {
        selector,
        top: row ? row.getBoundingClientRect().top : null,
        fromEnd: el.scrollHeight - el.scrollTop,
      };
    }
  }
  useLayoutEffect(() => {
    drawn.current = { scope, change };
    const was = before.current;
    before.current = null;
    const el = scrollRef.current;
    if (!was || !el) return;
    const row = was.selector && was.top !== null ? el.querySelector(was.selector) : null;
    if (row && was.top !== null) el.scrollTop += row.getBoundingClientRect().top - was.top;
    else el.scrollTop = el.scrollHeight - was.fromEnd;
  }, [scrollRef, scope, change]);
}
