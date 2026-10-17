// Composio hands out two kinds of key that look alike, and pasting one
// where the other goes was the most common way connecting apps failed:
// the save went through, and nothing connected. Caught at the paste,
// before a round trip, and said in terms of what to go and copy instead.
export function composioKeyMistake(section: "composio" | "composioApi", value: string): string | null {
  const key = value.trim();
  if (!key) return null;
  if (section === "composio" && key.startsWith("ak_")) {
    return "That's a Composio API key (ak_). Connecting apps needs the Connect key, which starts with ck_. Both are on your Composio dashboard.";
  }
  if (section === "composioApi" && key.startsWith("ck_")) {
    return "That's a Connect key (ck_), which goes in the Connect key field above. This field takes the API key, which starts with ak_.";
  }
  return null;
}
