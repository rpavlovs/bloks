// Whether the sidebar lists each agent's conversations under it.
//
// Kept on this device, like the rail choice: how much of the list you want
// in view depends on the screen, not on the workspace. Settings and the
// sidebar both flip it, so a change in one is heard by the other through
// a window event rather than a second copy of the state.
import { useEffect, useState } from "react";

const KEY = "bloks-show-conversations";
const EVENT = "bloks:conversations-view";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function useConversationsView(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const sync = () => setOn(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const set = (next: boolean) => {
    try {
      localStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      // private mode: the choice lasts as long as the window does
    }
    setOn(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return [on, set];
}

// Whether the sidebar is listing conversations right now: the view is on,
// the column is full width, and the window is wide enough to have one.
// The chat's tab strip only repeats that list, so it steps aside while
// this holds and comes back whenever the sidebar cannot show them.
const LANES_EVENT = "bloks:lanes-in-sidebar";
let lanesShown = false;

export function setLanesInSidebar(on: boolean) {
  if (on === lanesShown) return;
  lanesShown = on;
  window.dispatchEvent(new Event(LANES_EVENT));
}

export function useLanesInSidebar(): boolean {
  const [on, setOn] = useState(lanesShown);
  useEffect(() => {
    const sync = () => setOn(lanesShown);
    sync();
    window.addEventListener(LANES_EVENT, sync);
    return () => window.removeEventListener(LANES_EVENT, sync);
  }, []);
  return on;
}
