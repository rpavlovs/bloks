// A finished turn's work as one line (GitHub 257).
//
// What folds and what the line counts is decided in src/lib/turnFold.ts;
// this draws it. The line reads like the collapsed tool line it replaces
// a dozen of: small, muted, a chevron, and the work again in place when
// it is pressed. An agent that asked for the turn is named first, and
// its name is the way into the exchange between the two, which the
// "After a message from" link used to be.
import type { ReactNode } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import { useStore } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { askerWords, foldWords, type Asker, type TurnFold } from "@/lib/turnFold";
import { kindOf } from "@/lib/tool-summary";
import { goalNoteForPerson } from "@/lib/goalNote";
import { cn } from "@/lib/cn";

export function TurnFoldLine({
  fold,
  open,
  onToggle,
  onOpenExchange,
  className,
  children,
}: {
  fold: TurnFold;
  open: boolean;
  onToggle: () => void;
  onOpenExchange?: (asker: Extract<Asker, { by: "agent" }>) => void;
  className?: string;
  /** The work, drawn by whoever draws the conversation. Only when open. */
  children?: ReactNode;
}) {
  const { state } = useStore();
  const botOf = (id: string) => state.bots.find((b) => b.id === id);
  const asker = fold.asker;
  const askedBy = asker?.by === "agent" ? botOf(asker.peerId) : undefined;
  const speaker = fold.speaker ? botOf(fold.speaker) : undefined;
  const lead = asker
    ? askerWords(asker, { name: askedBy?.name, turn: asker.by === "goal" ? goalNoteForPerson(asker.text).turn : undefined })
    : null;
  // another agent's name is a button of its own, beside the one that opens
  const linked = asker?.by === "agent" && onOpenExchange ? asker : null;
  const counted = foldWords(fold, kindOf).join(" · ");
  const words = linked
    ? counted
    : lead
      ? `${lead} · ${counted}`
      : fold.speaker
        ? `${speaker?.name ?? "An agent"} ${counted}`
        : counted.charAt(0).toUpperCase() + counted.slice(1);
  const messaged = fold.messaged.map((peer) => ({ ...peer, bot: botOf(peer.peerId) }));
  const names = messaged.map((peer) => peer.bot?.name ?? peer.peerName);
  return (
    <div className={cn("flex flex-col items-start px-1.5", className)} data-turn-fold={fold.key}>
      <div
        className={cn(
          "flex min-w-0 max-w-full items-center gap-1.5 text-[12px]",
          // nothing was said to the person: quiet, like a quiet check-in
          fold.alone ? "text-muted-foreground/80" : "text-muted-foreground",
        )}
      >
        {linked && (
          <>
            <button
              onClick={() => onOpenExchange?.(linked)}
              title="Open the exchange"
              className="flex min-w-0 max-w-[50%] shrink-0 items-center gap-1.5 rounded-md py-0.5 transition-colors duration-150 hover:text-foreground"
            >
              {askedBy && <AgentAvatar bot={askedBy} size={16} className="shrink-0" />}
              <span className="truncate">{lead}</span>
            </button>
            <span aria-hidden>·</span>
          </>
        )}
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 rounded-md py-0.5 transition-colors duration-150 hover:text-foreground"
        >
          {speaker && <AgentAvatar bot={speaker} size={16} className="shrink-0" />}
          <span className="truncate">{words}</span>
          {messaged.length > 0 && (
            <span className="flex shrink-0 items-center gap-1" title={`Messaged ${names.join(", ")}`}>
              <span aria-hidden>·</span>
              <span className="sr-only">messaged</span>
              {messaged.map((peer) => peer.bot && <AgentAvatar key={peer.peerId} bot={peer.bot} size={16} />)}
              {/* one is named; several are faces, and names where a face is gone */}
              {messaged.length === 1 ? (
                <span>{names[0]}</span>
              ) : (
                messaged.some((peer) => !peer.bot) && (
                  <span>
                    {messaged
                      .filter((peer) => !peer.bot)
                      .map((peer) => peer.peerName)
                      .join(", ")}
                  </span>
                )
              )}
            </span>
          )}
          {fold.replied && <span className="shrink-0">· replied</span>}
          <ChevronRight size={12} className={cn("shrink-0 transition-transform duration-200", open && "rotate-90")} />
        </button>
      </div>
      {open && (
        <div className="ml-[5px] mt-1.5 flex animate-fade-in flex-col gap-2.5 self-stretch border-l pl-3">{children}</div>
      )}
    </div>
  );
}
