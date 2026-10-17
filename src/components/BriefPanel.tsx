// The morning brief (server/brief.ts): what your agents did while you
// were away, what is waiting on you, and a way to hear it.
//
// Play reads it as a round: an opening, then each agent in its own voice,
// then what is waiting. Every line links back to the conversation it came
// from, and approvals can be answered here without opening anything.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Pause from "lucide-react/dist/esm/icons/pause.mjs";
import Play from "lucide-react/dist/esm/icons/play.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Sunrise from "lucide-react/dist/esm/icons/sunrise.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { api, useStore } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { useEscape } from "@/lib/useEscape";
import { plural } from "@/lib/plural";

interface BriefPart {
  botId: string | null;
  name: string;
  items: Array<{ text: string; threadId: string }>;
  script: string;
}
interface BriefWaiting {
  botId: string;
  name: string;
  title: string;
  threadId: string;
  messageId: string;
  requestId?: string;
  kind: "approval" | "question";
}
export interface Brief {
  id: string;
  at: number;
  since: number;
  headline: string;
  parts: BriefPart[];
  waiting: BriefWaiting[];
  spend: { turns: number; cost: number; costKnown: boolean };
  ready: Array<{ label: string; many?: string; count: number }>;
  quiet: boolean;
  readAt?: number;
}

interface BriefList {
  briefs: Brief[];
  settings: { enabled: boolean; time: string };
  audio: boolean;
}

/** The briefs, newest first, re-read when the server says they changed. */
export function useBriefs() {
  const { state } = useStore();
  const [data, setData] = useState<BriefList | null>(null);
  const reload = useCallback(() => {
    api("/api/briefs")
      .then((r) => setData(r))
      .catch(() => setData({ briefs: [], settings: { enabled: true, time: "08:00" }, audio: false }));
  }, []);
  useEffect(reload, [reload, state.ticks.brief]);
  return { data, reload };
}

const day = (at: number) =>
  new Date(at).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

export function BriefPanel() {
  const { state, dispatch } = useStore();
  const { data, reload } = useBriefs();
  const [pick, setPick] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [playing, setPlayingState] = useState<number | null>(null);
  const playingRef = useRef<number | null>(null);
  const setPlaying = (index: number | null) => {
    playingRef.current = index;
    setPlayingState(index);
  };
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const close = () => dispatch({ type: "toggleBrief", open: false });

  const brief = useMemo(() => data?.briefs.find((b) => b.id === pick) ?? data?.briefs[0] ?? null, [data, pick]);

  // opening it is reading it
  useEffect(() => {
    if (brief && !brief.readAt) void api(`/api/briefs/${brief.id}/read`, { method: "POST" }).catch(() => {});
  }, [brief]);

  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  };
  useEffect(() => stop, []);
  useEscape(close);

  // Each part is fetched as a file and played from memory, the way the
  // rest of the app plays speech; the next one is fetched while this one
  // plays, so the round has no gaps.
  const fetchPart = (id: string, index: number): Promise<string> =>
    fetch(`/api/briefs/${id}/parts/${index}/audio`).then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "that part could not be played");
      return URL.createObjectURL(await res.blob());
    });

  const playFrom = (index: number, ready?: Promise<string>) => {
    if (!brief || index >= brief.parts.length) return stop();
    const id = brief.id;
    setPlaying(index);
    const next = index + 1 < brief.parts.length ? fetchPart(id, index + 1) : undefined;
    next?.catch(() => {});
    (ready ?? fetchPart(id, index))
      .then((url) => {
        // stopped, or moved on, while this part was loading
        if (playingRef.current !== index) return URL.revokeObjectURL(url);
        const player = new Audio(url);
        audio.current?.pause();
        audio.current = player;
        player.onended = () => {
          URL.revokeObjectURL(url);
          if (audio.current === player) playFrom(index + 1, next);
        };
        return player.play();
      })
      .catch((e: Error) => {
        setError(e.message || "Playback was blocked. Press play again.");
        stop();
      });
  };

  const make = () => {
    setMaking(true);
    setError(null);
    api("/api/briefs", { method: "POST" })
      .then((r) => {
        setPick(r.brief?.id ?? null);
        reload();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setMaking(false));
  };

  const open = (botId: string, threadId: string) => {
    dispatch({ type: "select", id: botId, lane: threadId });
    close();
  };

  const answer = (w: BriefWaiting, behavior: "allow" | "deny") => {
    if (!w.requestId) return;
    api(`/api/bots/${w.botId}/respond`, { method: "POST", body: JSON.stringify({ requestId: w.requestId, behavior }) })
      .then(() => setAnswered((prev) => ({ ...prev, [w.messageId]: behavior === "allow" ? "Allowed" : "Denied" })))
      .catch((e: Error) => setError(e.message));
  };

  const settings = (patch: { enabled?: boolean; time?: string }) =>
    api("/api/briefs/settings", { method: "PATCH", body: JSON.stringify(patch) }).then(reload).catch((e: Error) => setError(e.message));

  return (
    <div
      className="absolute inset-0 z-20 flex animate-fade-in items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={close}
    >
      <div
        className="flex h-[84%] w-[760px] max-w-[94vw] animate-pop-in flex-col overflow-hidden rounded-2xl border bg-popover shadow-2xl shadow-(color:--shadow-color)"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Morning brief"
      >
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[16px] font-semibold text-foreground">
              <Sunrise size={17} className="text-muted-foreground" />
              Morning brief
            </div>
            <div className="mt-0.5 truncate text-[13px] text-muted-foreground">
              {brief ? day(brief.at) : "What your agents did while you were away"}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {brief && data?.audio && (
              <Button size="sm" onClick={() => (playing === null ? playFrom(0) : stop())}>
                {playing === null ? <Play size={14} /> : <Pause size={14} />}
                {playing === null ? "Play" : "Stop"}
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={making} onClick={make} title="Make a brief of everything since the last one">
              {making ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Now
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Close the brief" onClick={close}>
              <X size={16} />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {error && <div className="mb-3 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</div>}
          {!data ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Reading
            </div>
          ) : !brief ? (
            <div className="rounded-2xl border border-dashed px-6 py-12 text-center text-[13px] leading-relaxed text-muted-foreground">
              Your first brief arrives at {data.settings.time}. Press <strong>Now</strong> to make one of the last day.
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              <p className="text-balance text-[20px] font-semibold leading-snug tracking-tight text-foreground">{brief.headline}</p>

              {brief.parts
                .map((part, index) => ({ part, index }))
                .filter(({ part }) => part.botId)
                .map(({ part, index }) => {
                  const agent = state.bots.find((b) => b.id === part.botId);
                  return (
                    <section
                      key={index}
                      className={cn("rounded-2xl border p-4 transition-colors", playing === index && "border-brand/50 bg-brand-soft/30")}
                    >
                      <div className="mb-2 flex items-center gap-2.5">
                        {agent && <AgentAvatar bot={agent} size={26} />}
                        <span className="text-[14px] font-semibold text-foreground">{part.name}</span>
                        {agent?.title && <span className="truncate text-[12px] text-muted-foreground">{agent.title}</span>}
                      </div>
                      <ul className="flex flex-col gap-1.5">
                        {part.items.map((item, i) => (
                          <li key={i}>
                            <button
                              onClick={() => part.botId && open(part.botId, item.threadId)}
                              className="group flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left text-[13.5px] leading-relaxed text-foreground transition-colors hover:bg-accent"
                            >
                              <span className="min-w-0 flex-1">{item.text}</span>
                              <ArrowUpRight size={13} className="mt-1 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}

              {brief.waiting.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Waiting on you</h3>
                  <ul className="flex flex-col gap-2">
                    {brief.waiting.map((w) => {
                      const agent = state.bots.find((b) => b.id === w.botId);
                      const done = answered[w.messageId];
                      return (
                        <li key={w.messageId} className="flex items-center gap-3 rounded-xl border px-3 py-2.5">
                          {agent && <AgentAvatar bot={agent} size={22} />}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] text-foreground">{w.title}</div>
                            <div className="text-[11.5px] text-muted-foreground">
                              {w.name} {w.kind === "approval" ? "wants your OK" : "has a question"}
                            </div>
                          </div>
                          {done ? (
                            <span className="text-[12px] text-muted-foreground">{done}</span>
                          ) : w.kind === "approval" && w.requestId ? (
                            <div className="flex shrink-0 gap-1.5">
                              <Button size="sm" variant="secondary" onClick={() => answer(w, "deny")}>
                                Deny
                              </Button>
                              <Button size="sm" onClick={() => answer(w, "allow")}>
                                Allow
                              </Button>
                            </div>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => open(w.botId, w.threadId)}>
                              Answer
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {(brief.ready.length > 0 || brief.spend.turns > 0) && (
                <div className="flex flex-wrap gap-2 text-[12px] text-muted-foreground">
                  {brief.ready.map((r) => (
                    <span key={r.label} className="rounded-full bg-muted px-2.5 py-1">
                      {r.count} {r.count === 1 ? r.label : (r.many ?? `${r.label}s`)} ready
                    </span>
                  ))}
                  {brief.spend.turns > 0 && (
                    <span className="rounded-full bg-muted px-2.5 py-1">
                      {plural(brief.spend.turns, "turn")}
                      {brief.spend.costKnown && brief.spend.cost > 0 ? `, about $${brief.spend.cost.toFixed(2)}` : ""}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-[12.5px] text-muted-foreground">
          <label className="flex items-center gap-2">
            <Switch checked={data?.settings.enabled ?? true} onCheckedChange={(on) => settings({ enabled: on })} aria-label="Brief every day" />
            Every day at
            <input
              type="time"
              value={data?.settings.time ?? "08:00"}
              onChange={(e) => e.target.value && settings({ time: e.target.value })}
              className="rounded-md border bg-background px-1.5 py-0.5 text-[12.5px] text-foreground"
              aria-label="Brief time"
            />
          </label>
          {data && data.briefs.length > 1 && (
            <select
              value={brief?.id ?? ""}
              onChange={(e) => setPick(e.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-[12.5px] text-foreground"
              aria-label="Earlier briefs"
            >
              {data.briefs.map((b) => (
                <option key={b.id} value={b.id}>
                  {day(b.at)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}
