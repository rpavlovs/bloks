// Where a new agent starts: a folder, approvals, a model and an effort, applied
// before its first turn, because a chat's folder is pinned on that turn
// and cannot be moved after it.
//
// Set by the person only. Agents cannot read or write /api/config, so an
// agent that hires another cannot hand it more than the person chose
// here, and an agent hiring another passes on no more approvals than it
// has itself. The server checks each value again at hire time; this card
// only shows what it refused.
//
// A server that does not report agentDefaults does not have the feature,
// and the card is not drawn at all rather than offering a form that
// saves nowhere.
import { useEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import { api, useStore, type AgentDefaults as Defaults } from "@/state/store";
import { ModelPicker } from "./ModelPicker";
import { BrowseFolderButton } from "@/components/ui/browse-folder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { Segmented } from "@/components/ui/segmented";
import { SettingRow, SettingsGroup } from "./SettingsLayout";
import { confirmWidening } from "./ApprovalsChooser";

const APPROVALS = [
  [undefined, "Ask"],
  ["edits", "Accept edits"],
  ["auto", "Auto"],
  ["full", "Full access"],
] as const;

const EFFORTS = [
  [undefined, "Default"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
] as const;

export function AgentDefaults() {
  const { state, dispatch } = useStore();
  const saved = state.config?.agentDefaults;
  const [folder, setFolder] = useState(saved?.cwd ?? "");
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [refused, setRefused] = useState(false);
  const hydrated = useRef(false);

  // adopt the server value once it arrives, without stomping an edit
  useEffect(() => {
    if (hydrated.current || !saved) return;
    hydrated.current = true;
    setFolder(saved.cwd ?? "");
  }, [saved]);

  if (!saved) return null;

  /** The whole object every time: the server replaces the section, so
   * an unset key is one left out, not one sent empty. */
  const save = (patch: Partial<Defaults>) => {
    const next: Defaults = { ...saved, ...patch };
    for (const key of Object.keys(next) as Array<keyof Defaults>) {
      if (next[key] === undefined || next[key] === null || next[key] === "") delete next[key];
    }
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ agentDefaults: next }) })
      .then((status) => {
        dispatch({ type: "configStatus", config: status });
        setFolder(status?.agentDefaults?.cwd ?? "");
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 1600);
      })
      .catch((e: Error) => setError(e.message));
  };

  const saveFolder = (value: string) => save({ cwd: value.trim() || undefined });
  const anySet = Boolean(saved.cwd || saved.approvals || saved.modelSelection || saved.effort);

  /** Auto for every new agent asks who is there, exactly as Auto for one
   * agent does in its own settings. Without that, this card would be the
   * way around the check. Narrowing never asks. */
  const chooseApprovals = async (next: Defaults["approvals"]) => {
    setRefused(false);
    if (!(await confirmWidening(saved.approvals ?? "ask", next ?? "ask", "new agents"))) {
      setRefused(true);
      return;
    }
    save({ approvals: next });
  };

  return (
    <>
      <SettingsGroup title="Where they start">
        <SettingRow
          label="Working folder"
          info="Applied the moment an agent is made, so its first chat already runs in the folder. Only you can change these; agents cannot. Team hires keep the lighter model the team chose and take the rest."
          description={error ? <span className="text-destructive">{error}</span> : "Existing agents keep their own settings."}
          control={
            <span
              className={cn(
                "flex items-center gap-1 text-[11.5px] text-success transition-opacity duration-200",
                justSaved ? "opacity-100" : "opacity-0",
              )}
              aria-live="polite"
            >
              <Check size={12} /> Saved
            </span>
          }
        >
          <div className="mt-3 flex gap-2">
            <Input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveFolder(folder)}
              placeholder="Their own workspace"
              spellCheck={false}
              aria-label="Working folder for new agents"
              className="h-8 font-mono text-[12px]"
            />
            <BrowseFolderButton
              onPick={(path) => {
                setFolder(path);
                saveFolder(path);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={folder.trim() === (saved.cwd ?? "")}
              onClick={() => saveFolder(folder)}
            >
              Save
            </Button>
          </div>
        </SettingRow>
        <SettingRow
          label="Model"
          description="The engine and model they think with."
          control={
            <ModelPicker
              value={saved.modelSelection ?? null}
              onPick={(selection) => save({ modelSelection: selection ?? undefined })}
              noneLabel="Engine default"
            />
          }
        />
        <SettingRow
          label="Reasoning effort"
          control={
            <Segmented
              size="sm"
              aria-label="Reasoning effort"
              value={saved.effort}
              onChange={(effort) => save({ effort })}
              options={EFFORTS.map(([value, label]) => ({ value, label }))}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="What they may do">
        <SettingRow
          label="Approvals"
          info="An agent that hires another never hands on more approvals than it has itself. Choosing Auto asks for Touch ID, the same as it does for one agent."
          description={
            refused ? (
              <span className="text-warning">Not confirmed, so approvals are unchanged.</span>
            ) : (
              "How much a new agent does before asking you."
            )
          }
          control={
            <Segmented
              size="sm"
              aria-label="Approvals for new agents"
              value={saved.approvals}
              onChange={(mode) => void chooseApprovals(mode)}
              options={APPROVALS.map(([value, label]) => ({ value, label }))}
            />
          }
        />
      </SettingsGroup>
      {anySet && (
        <button
          onClick={() => save({ cwd: undefined, approvals: undefined, modelSelection: undefined, effort: undefined })}
          className="px-1 text-[12.5px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          Reset to the built-in start
        </button>
      )}
    </>
  );
}
