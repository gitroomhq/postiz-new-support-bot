import { IntercomHttpError, type IntercomClient } from "./IntercomClient";
import { conflictingContactId } from "./IntercomEventExecutor";

// The one way an email-identified contact is resolved: the Sentry feedback
// import and the forwarded-email conversion both create conversations AS the
// customer, and both used to carry their own slightly different ladder. The
// Sentry one lacked the conflict-by-id rung, which is how one archived
// submitter stopped the entire feedback import for thirteen days.
//
// Ladder:
//   1. search by email — prefer a user-role record, reuse a lead as-is
//   2. create
//   3. on a create conflict, resolve the record Intercom names in the error:
//      unarchive it when archived, reuse it when live
//   4. fall back to one re-search (a plain create race)
//
// Every rung exists because search cannot see archived contacts while create
// still conflicts with them: without step 3 such a submitter is unreachable.

export type EmailContactMatch = { id: string; role: "user" | "lead" | null };

type ContactClient = Pick<
  IntercomClient,
  "searchContactsByEmail" | "createEmailContact" | "getContact" | "unarchiveContact"
>;

export interface EnsureEmailContactOptions {
  // Called immediately before each Intercom WRITE (the shared sweep pacing).
  beforeWrite?: () => Promise<void>;
  // Reported rather than thrown: reviving a contact is a repair, not the job.
  onWarn?: (message: string, fields: Record<string, unknown>) => void;
}

export async function ensureEmailContact(
  client: ContactClient,
  input: { email: string; name: string | null },
  opts: EnsureEmailContactOptions = {}
): Promise<EmailContactMatch> {
  const pick = (matches: EmailContactMatch[]): EmailContactMatch | null =>
    matches.find((m) => m.role === "user") ?? matches.find((m) => m.role === "lead") ?? null;

  const found = pick(await client.searchContactsByEmail(input.email));
  if (found) return found;

  await opts.beforeWrite?.();
  try {
    return { id: (await client.createEmailContact(input)).id, role: "user" };
  } catch (e) {
    // 409 = a record already holds this email; 422 = Intercom's other shape for
    // the same conflict. Anything else is a real failure.
    if (!(e instanceof IntercomHttpError && (e.status === 409 || e.status === 422))) throw e;

    const blockingId = conflictingContactId(e);
    if (blockingId) {
      const existing = await client.getContact(blockingId).catch(() => null);
      if (existing?.archived) {
        // Intercom's "delete contact" only archives, and an archived contact
        // can neither be found by search nor author a conversation.
        await opts.beforeWrite?.();
        try {
          await client.unarchiveContact(existing.id);
          opts.onWarn?.("revived an archived Intercom contact to import feedback", {
            "intercom.contact_id": existing.id,
          });
          return { id: existing.id, role: existing.role ?? "user" };
        } catch (unarchiveErr) {
          // Inside Intercom's permanent-deletion grace the record is not
          // restorable; nothing else can be done with this email today.
          opts.onWarn?.("archived Intercom contact could not be revived", {
            "intercom.contact_id": existing.id,
            "error.message": unarchiveErr instanceof Error ? unarchiveErr.message : String(unarchiveErr),
          });
        }
      } else if (existing) {
        // Live but invisible to search (indexing lag, or an alias on another
        // record): the conflict itself already told us which contact to use.
        return { id: existing.id, role: existing.role ?? "user" };
      }
    }

    // A plain create race. Any record matching the email will do by this
    // point — a roleless one still authors the conversation.
    const retry = await client.searchContactsByEmail(input.email);
    const raced = pick(retry) ?? retry[0] ?? null;
    if (raced) return raced;
    throw e;
  }
}
