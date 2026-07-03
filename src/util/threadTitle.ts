// Thread titles carry up to two leading emoji slots: "{status} {priority} {rest}".
// The first token is always the status emoji (other code derives status from
// name.split(" ")[0], so that invariant must hold). The second token is the
// priority emoji only when it matches a configured priority — that's how legacy
// one-emoji titles stay parseable without a marker character. Status and priority
// emoji sets are kept disjoint by the SettingsStore CRUD.

export interface TitleEmojiUpdate {
  // undefined = keep the current value; for priority, null removes the slot.
  statusEmoji?: string;
  priorityEmoji?: string | null;
}

export function applyTitleEmojis(
  currentName: string,
  update: TitleEmojiUpdate,
  isPriorityEmoji: (token: string) => boolean
): string {
  const tokens = currentName.split(" ");

  let currentStatus: string | undefined;
  let currentPriority: string | undefined;
  let rest: string;

  if (tokens.length > 0 && isPriorityEmoji(tokens[0])) {
    // No status slot (a priority-only title, e.g. from an adopted thread).
    currentPriority = tokens[0];
    rest = tokens.slice(1).join(" ");
  } else if (tokens.length === 1) {
    // No space: mirror the legacy rename behavior and treat the whole name as
    // the rest, so adopted threads with plain names keep them.
    rest = currentName;
  } else {
    currentStatus = tokens[0];
    if (isPriorityEmoji(tokens[1])) {
      currentPriority = tokens[1];
      rest = tokens.slice(2).join(" ");
    } else {
      rest = tokens.slice(1).join(" ");
    }
  }

  const status = update.statusEmoji ?? currentStatus;
  const priority = update.priorityEmoji === undefined ? currentPriority : update.priorityEmoji;

  return [status, priority ?? undefined, rest]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" ")
    .slice(0, 100);
}
