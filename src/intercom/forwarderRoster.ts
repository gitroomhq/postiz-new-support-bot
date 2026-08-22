import type { SettingsStore } from "../config/SettingsStore";
import type { IntercomClient } from "./IntercomClient";
import type { IntercomAdmin } from "./types";

// Teammate roster cache. Both the forwarded-email converter (per inbound
// email) and the forwarder detacher (per multi-participant conversation) ask
// the same questions, and neither may hammer /admins.
const ADMINS_TTL_MS = 5 * 60 * 1000;

// Who counts as a forwarder, and who must never be treated as a customer.
//
// ONE definition, shared by the two halves of the forwarded-email feature:
//   - ForwardedEmailConverter recreates the conversation for the original
//     sender when OUR bot has to do the conversion (lite seats, listed
//     addresses — Intercom's native detection skips those).
//   - ForwarderDetacher cleans up after Intercom's NATIVE detection, which
//     attaches the real customer but leaves the forwarder attached as well.
// A second copy of this predicate would let the two disagree about who a
// forwarder is, which is exactly the bug that produces half-converted threads.
export class ForwarderRoster {
  private cache: { at: number; admins: IntercomAdmin[] } | null = null;

  constructor(
    private settingsStore: SettingsStore,
    private client: IntercomClient
  ) {}

  async admins(): Promise<IntercomAdmin[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < ADMINS_TTL_MS) return this.cache.admins;
    const admins = await this.client.listAdmins();
    this.cache = { at: now, admins };
    return admins;
  }

  // Forwarder set = lite-seat teammates (dynamic) ∪ the configured extra
  // addresses (personal mailboxes etc.). Listed entries check first — no
  // roster fetch needed when they match.
  async isForwarderEmail(email: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return false;
    if (this.settingsStore.forwardConvertExtraEmails().includes(normalized)) return true;
    return this.isLiteSeatEmail(normalized);
  }

  async isLiteSeatEmail(email: string): Promise<boolean> {
    const admins = await this.admins();
    return admins.some((a) => !a.hasInboxSeat && a.email?.toLowerCase() === email);
  }

  async isAnyAdminEmail(email: string): Promise<boolean> {
    const admins = await this.admins();
    return admins.some((a) => a.email?.toLowerCase() === email);
  }

  // Addresses that must never become the conversion TARGET: teammates and the
  // listed forwarders themselves (a "customer" conversation for either would
  // be wrong in every direction).
  async isProtectedTargetEmail(email: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    if (this.settingsStore.forwardConvertExtraEmails().includes(normalized)) return true;
    return this.isAnyAdminEmail(normalized);
  }
}
