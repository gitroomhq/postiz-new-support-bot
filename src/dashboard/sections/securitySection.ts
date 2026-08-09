import qrcode from "qrcode-generator";
import { MIN_PASSPHRASE_LENGTH } from "../auth/passphrase";
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from "../auth/totp";
import { parseYubiOtp, verifyYubiOtp } from "../auth/yubikeyOtp";
import { CredentialStore } from "../auth/CredentialStore";
import { DashboardDbSessions } from "../auth/DashboardDbSessions";
import { DashboardAudit } from "../auth/DashboardAudit";
import { ActionResult, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str } from "./types";

// Security page (#/security): the admin's own sessions, credentials,
// enrollment ceremonies and the recent-activity feed. Everything here is
// OWNER-SCOPED (the acting admin's rows only) and reduce-only where it touches
// global state — the web can sign-out-everywhere (epoch bump) but can never
// enable, restore or edit the allowlist (ratchet asymmetry; those levers live
// in the Discord-anchored Dashboard hub).

const PENDING_TOTP_TTL_MS = 5 * 60 * 1000;

export function makeSecuritySection(deps: {
  credentials: CredentialStore;
  sessions: DashboardDbSessions;
  audit: DashboardAudit;
}): DashboardSectionModule {
  // TOTP enrollments mid-ceremony (secret shown, code not yet confirmed).
  const pendingTotp = new Map<string, { secret: Buffer; at: number }>();
  const prunePending = () => {
    const cutoff = Date.now() - PENDING_TOTP_TTL_MS;
    for (const [k, v] of pendingTotp) if (v.at < cutoff) pendingTotp.delete(k);
  };

  return {
    nav: [{ key: "security", label: "Security", page: "security", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "security" || page === "security.totp";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "security.totp") return totpEnrollPage(ctx);
      return securityPage(ctx);
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const p = req.params ?? {};
      switch (req.key) {
        case "section:security.set_passphrase": {
          const passphrase = str(p.passphrase, 200);
          const confirm = str(p.confirm, 200);
          if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
            return { ok: false, fieldErrors: { passphrase: `At least ${MIN_PASSPHRASE_LENGTH} characters.` } };
          }
          if (passphrase !== confirm) return { ok: false, fieldErrors: { confirm: "Passphrases don't match." } };
          // Changing an EXISTING passphrase needs a fresh factor (T2) unless
          // this is the initial Discord-ceremonied setup.
          const had = await deps.credentials.hasPassphrase(ctx.actor.id);
          if (had && ctx.security.authMethod !== "breakglass" && !ctx.security.stepUpFresh()) {
            return { ok: false, needsStepUp: true };
          }
          await deps.credentials.setPassphrase(ctx.actor.id, passphrase);
          await recordAudit(deps.audit, ctx, "passphrase.set", had ? "Passphrase changed" : "Passphrase set");
          return { ok: true, text: had ? "Passphrase changed." : "Passphrase set. Now add a passkey." };
        }
        case "section:security.totp_confirm": {
          prunePending();
          const pending = pendingTotp.get(ctx.actor.id);
          if (!pending) return { ok: false, error: "Enrollment expired. Start over." };
          const code = str(p.code, 10);
          const result = verifyTotp(pending.secret, code, null);
          if (!result.ok) return { ok: false, fieldErrors: { code: "That code didn't match. Try the next one." } };
          await deps.credentials.setTotp(ctx.actor.id, pending.secret, str(p.label, 80) || "Authenticator");
          pendingTotp.delete(ctx.actor.id);
          await recordAudit(deps.audit, ctx, "totp.enrolled", "Authenticator (TOTP) enrolled");
          return { ok: true, text: "Authenticator enrolled." };
        }
        case "section:security.yubikey_add": {
          // Enrolling a yubikey mints a bypass factor (direct sign-in), so it
          // rides the same fresh-factor rule as trusted passkeys.
          if (!ctx.security.stepUpFresh() && ctx.security.authMethod !== "breakglass") {
            return { ok: false, needsStepUp: true };
          }
          const clientId = ctx.settings.yubicoClientId();
          if (!clientId) {
            return { ok: false, error: "YubiKey sign-in is not configured (/config → Open Web Panel → Dashboard)." };
          }
          const parsed = parseYubiOtp(str(p.otp, 64));
          if (!parsed) return { ok: false, fieldErrors: { otp: "That doesn't look like a YubiKey OTP. Click the field and touch the key." } };
          if (await deps.credentials.findYubikeyByPublicId(parsed.publicId)) {
            return { ok: false, fieldErrors: { otp: "This key is already enrolled." } };
          }
          const verified = await verifyYubiOtp(parsed.otp, {
            clientId,
            apiSecret: ctx.settings.yubicoApiSecret(),
            verifyUrl: ctx.settings.yubicoValidationUrl(),
          });
          if (!verified.ok) {
            return {
              ok: false,
              fieldErrors: {
                otp:
                  verified.reason === "unreachable" || verified.reason === "backend_error"
                    ? "Verification service unreachable. Try again."
                    : "That OTP didn't verify. Touch the key again.",
              },
            };
          }
          await deps.credentials.addYubikey({
            discordUserId: ctx.actor.id,
            label: str(p.label, 80) || "YubiKey",
            publicId: parsed.publicId,
          });
          await recordAudit(deps.audit, ctx, "yubikey.enrolled", `YubiKey enrolled (${parsed.publicId})`);
          return { ok: true, text: "YubiKey enrolled. A touch now signs you in directly." };
        }
        case "section:security.revoke_credential": {
          const id = str(p.id, 64);
          if (!ctx.reverse?.satisfied && !ctx.security.stepUpFresh() && ctx.security.authMethod !== "breakglass") {
            return { ok: false, needsStepUp: true };
          }
          const ok = await deps.credentials.revoke(ctx.actor.id, id);
          if (!ok) return { ok: false, error: "Credential not found." };
          await recordAudit(deps.audit, ctx, "credential.revoked", `Credential ${id} revoked`);
          return { ok: true, text: "Credential revoked." };
        }
        case "section:security.revoke_session": {
          const idHash = str(p.idHash, 80);
          const ok = await deps.sessions.revokeByIdHash(ctx.actor.id, idHash);
          if (!ok) return { ok: false, error: "Session not found." };
          await recordAudit(deps.audit, ctx, "session.revoked", "Session revoked from the Security page");
          return { ok: true, text: "Session revoked." };
        }
        case "section:security.signout_everywhere": {
          // Reduce-only global lever: kills every dashboard session (incl.
          // this one) by bumping the epoch. Re-entry = fresh sign-in.
          const epoch = await ctx.settings.bumpDashboardEpoch();
          await recordAudit(deps.audit, ctx, "session.signout_everywhere", `Epoch bumped to ${epoch}`);
          return { ok: true, text: "Signed out everywhere. Sign in again." };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };

  async function securityPage(ctx: DashboardCtx): Promise<SectionPage> {
    prunePending();
    const [credentials, sessions, events, hasPassphrase] = await Promise.all([
      deps.credentials.listForUser(ctx.actor.id),
      deps.sessions.listForUser(ctx.actor.id, ctx.settings.dashboardEpoch()),
      deps.audit.recent(15, ctx.actor.id),
      deps.credentials.hasPassphrase(ctx.actor.id),
    ]);
    // Stripe detail archetype: tables + activity in the main column, the
    // factor status card and the emergency levers in the right rail.
    const blocks: Block[] = [];
    const rail: Block[] = [];

    blocks.push({
      type: "header",
      title: "Security",
      badges: [
        {
          kind: ctx.security.authMethod === "breakglass" ? "warn" : "ok",
          text: `signed in via ${ctx.security.authMethod}`,
        },
      ],
    });

    // Onboarding notices for the standing stack.
    if (!hasPassphrase) {
      blocks.push({
        type: "notice",
        badge: { kind: "warn", text: "SETUP" },
        text: "No passphrase yet. Set one (right rail), then register a passkey. After that you sign in at this URL directly, no Discord link needed.",
      });
    } else if (!credentials.some((c) => c.kind === "passkey")) {
      blocks.push({
        type: "notice",
        badge: { kind: "warn", text: "SETUP" },
        text: "Passphrase is set. Now register a passkey (Touch ID / Windows Hello / security key) to finish standing-login setup.",
      });
    }

    // Passphrase + enrollment (rail card).
    const yubiConfigured = ctx.settings.yubicoClientId() != null;
    rail.push({
      type: "kv",
      title: "Sign-in factors",
      rows: [
        { label: "Passphrase", cell: badgeCell(hasPassphrase ? "ok" : "warn", hasPassphrase ? "set" : "not set") },
        {
          label: "Passkeys",
          cell: badgeCell(
            credentials.some((c) => c.kind === "passkey") ? "ok" : "warn",
            String(credentials.filter((c) => c.kind === "passkey").length)
          ),
        },
        {
          label: "YubiKeys (OTP)",
          cell: badgeCell(
            credentials.some((c) => c.kind === "yubikey") ? "ok" : "neutral",
            yubiConfigured ? String(credentials.filter((c) => c.kind === "yubikey").length) : "not configured"
          ),
        },
        {
          label: "Authenticator (TOTP)",
          cell: badgeCell(credentials.some((c) => c.kind === "totp") ? "ok" : "neutral",
            credentials.some((c) => c.kind === "totp") ? "enrolled" : "not enrolled"),
        },
        {
          label: "Enroll authenticator",
          cell: {
            t: "link",
            v: credentials.some((c) => c.kind === "totp") ? "Re-enroll (QR page)" : "Open enrollment page (QR)",
            ref: { page: "security.totp", params: { id: "enroll" } },
          },
        },
      ],
      actions: [
        {
          key: "section:security.set_passphrase",
          label: hasPassphrase ? "Change passphrase" : "Set passphrase",
          style: "primary",
          inputs: [
            { type: "text", key: "passphrase", label: `New passphrase (min ${MIN_PASSPHRASE_LENGTH} chars)` },
            { type: "text", key: "confirm", label: "Repeat passphrase" },
          ],
          summary: "The knowledge factor, asked after every untrusted passkey touch at sign-in.",
        },
        {
          key: "auth-register",
          label: "Register passkey on this device",
          special: "passkey-register",
          disabledReason: hasPassphrase ? undefined : "Set a passphrase first.",
        },
        {
          key: "auth-register-trusted",
          label: "Register trusted passkey",
          special: "passkey-register",
          params: { trusted: true },
          summary:
            "A trusted passkey signs you in directly: no passphrase, no Discord confirmation " +
            "(you still get a sign-in DM with a lockdown button). Requires a fresh step-up.",
          disabledReason: hasPassphrase ? undefined : "Set a passphrase first.",
        },
        {
          key: "section:security.yubikey_add",
          label: "Add YubiKey",
          stepUp: true,
          inputs: [
            { type: "text", key: "otp", label: "Click here, then touch your YubiKey" },
            { type: "text", key: "label", label: "Label (optional)", placeholder: "e.g. Keychain YubiKey 5" },
          ],
          summary:
            "A YubiKey OTP touch signs you in directly: no passphrase, no Discord confirmation " +
            "(you still get a sign-in DM with a lockdown button).",
          disabledReason: yubiConfigured
            ? undefined
            : "Set the Yubico API client ID first: /config → Open Web Panel → Dashboard.",
        },
      ],
    });

    // Emergency levers (rail card).
    rail.push({
      type: "kv",
      title: "Emergency",
      rows: [
        {
          label: "Sign out everywhere",
          cell: { t: "text", v: "Kills every dashboard session and link (including this one)." },
        },
        {
          label: "Lockdown",
          cell: { t: "text", v: "Full lockdown (disable + revoke) lives in Discord: /config → Open Web Panel → Dashboard. The web can only reduce its own access." },
        },
      ],
      actions: [
        {
          key: "section:security.signout_everywhere",
          label: "Sign out everywhere",
          style: "danger",
          dangerous: true,
          summary: "Bumps the dashboard epoch: every session and outstanding link dies. You sign in again afterwards.",
        },
      ],
    });

    // Credentials table.
    blocks.push({
      type: "table",
      key: "credentials",
      title: "Credentials",
      columns: [
        { key: "kind", label: "Kind" },
        { key: "label", label: "Label" },
        { key: "created", label: "Enrolled" },
        { key: "used", label: "Last used" },
      ],
      rows: credentials
        .filter((c) => c.kind !== "passphrase")
        .map((c) => ({
          id: c.id,
          cells: [
            {
              t: "badge",
              b:
                c.kind === "passkey" && c.trusted
                  ? { kind: "warn", text: "passkey (trusted)" }
                  : { kind: c.kind === "passkey" ? "info" : c.kind === "yubikey" ? "warn" : "neutral", text: c.kind },
            },
            { t: "text", v: c.label ?? "N/A" },
            isoDate(c.createdAt),
            c.lastUsedAt ? isoDate(c.lastUsedAt) : { t: "text", v: "never" },
          ] as Cell[],
          actions: [
            {
              key: "section:security.revoke_credential",
              label: "Revoke",
              style: "danger" as const,
              dangerous: true,
              stepUp: true,
              params: { id: c.id },
              summary: "Removes this credential. You can no longer sign in with it.",
            },
          ],
        })),
      empty: "No passkeys or authenticators enrolled yet.",
    });

    // Sessions table.
    blocks.push({
      type: "table",
      key: "sessions",
      title: "Sessions",
      columns: [
        { key: "device", label: "Device" },
        { key: "method", label: "Method" },
        { key: "ip", label: "IP (first → last)" },
        { key: "seen", label: "Last seen" },
        { key: "state", label: "State" },
      ],
      rows: sessions.map((s) => {
        const current = s.idHash === ctx.security.sessionIdHash;
        return {
          id: s.idHash,
          cells: [
            { t: "text", v: shortUa(s.uaFirst), sub: current ? "this session" : undefined },
            { t: "badge", b: { kind: s.authMethod === "breakglass" ? "warn" : "info", text: s.authMethod } },
            { t: "text", v: `${s.ipFirst ?? "?"}${s.ipLast && s.ipLast !== s.ipFirst ? ` → ${s.ipLast}` : ""}` },
            isoDate(s.lastSeenAt),
            { t: "badge", b: { kind: s.state === "active" ? "ok" : "warn", text: s.state } },
          ] as Cell[],
          actions: current
            ? []
            : [
                {
                  key: "section:security.revoke_session",
                  label: "Revoke",
                  style: "danger" as const,
                  params: { idHash: s.idHash },
                },
              ],
        };
      }),
      empty: "No live sessions.",
      notice: "Sessions: 7 days idle / 30 days maximum. Revoking a session signs that device out immediately.",
    });

    // Recent activity.
    blocks.push({
      type: "timeline",
      title: "Recent activity",
      items: events.map((e) => ({
        label: `${e.action} · ${e.summary}`,
        iso: e.at.toISOString(),
        text: e.ip ? `from ${e.ip}` : undefined,
        kind: e.outcome === "ok" ? ("info" as const) : ("error" as const),
      })),
    });

    return {
      title: "Security",
      crumbs: [{ label: "Security" }],
      blocks,
      rail,
    };
  }

  async function totpEnrollPage(ctx: DashboardCtx): Promise<SectionPage> {
    prunePending();
    let pending = pendingTotp.get(ctx.actor.id);
    if (!pending) {
      pending = { secret: newTotpSecret(), at: Date.now() };
      pendingTotp.set(ctx.actor.id, pending);
    }
    const uri = otpauthUri(ctx.actor.name, "Billing dashboard", pending.secret);
    const blocks: Block[] = [
      { type: "header", title: "Enroll authenticator" },
      {
        type: "qr",
        path: qrToSvgPath(uri),
        size: qrSize(uri),
        caption: "Scan with Google Authenticator / 1Password / Authy, then confirm a code below.",
      },
      {
        type: "kv",
        title: "Manual entry",
        rows: [
          { label: "Secret (base32)", cell: { t: "id", v: base32Encode(pending.secret), copy: true } },
          { label: "Type", cell: { t: "text", v: "Time-based (TOTP), SHA-1, 6 digits, 30s" } },
        ],
        actions: [
          {
            key: "section:security.totp_confirm",
            label: "Confirm code",
            style: "primary",
            inputs: [
              { type: "text", key: "code", label: "6-digit code from the app" },
              { type: "text", key: "label", label: "Label (optional)", placeholder: "e.g. 1Password" },
            ],
          },
        ],
      },
      {
        type: "notice",
        badge: { kind: "warn", text: "SECRET" },
        text: "This secret is shown once, during enrollment. Anyone who scans it can generate your codes.",
      },
    ];
    return {
      title: "Enroll authenticator",
      crumbs: [{ label: "Security", ref: { page: "security" } }, { label: "Authenticator" }],
      blocks,
    };
  }
}

async function recordAudit(audit: DashboardAudit, ctx: DashboardCtx, action: string, summary: string): Promise<void> {
  await audit.record({
    actorId: ctx.actor.id,
    actorName: ctx.actor.name,
    kind: "auth",
    action,
    summary,
    outcome: "ok",
    sessionIdHash: ctx.security.sessionIdHash,
  });
  await ctx.audit(summary);
}

function badgeCell(kind: "ok" | "warn" | "neutral", text: string): Cell {
  return { t: "badge", b: { kind, text } };
}

function isoDate(d: Date): Cell {
  const iso = d.toISOString();
  return { t: "date", v: iso.slice(0, 16).replace("T", " "), iso };
}

function shortUa(ua: string | null): string {
  if (!ua) return "unknown device";
  if (/iPhone|iPad/.test(ua)) return "iOS device";
  if (/Android/.test(ua)) return "Android device";
  if (/Macintosh/.test(ua)) return /Safari/.test(ua) && !/Chrome/.test(ua) ? "Mac · Safari" : "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return ua.slice(0, 40);
}

// qrcode-generator → one SVG path ("M x y h1 v1 h-1 z" per dark module).
function buildQr(data: string) {
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  return qr;
}

const QUIET = 2;

function qrSize(data: string): number {
  return buildQr(data).getModuleCount() + QUIET * 2;
}

function qrToSvgPath(data: string): string {
  const qr = buildQr(data);
  const n = qr.getModuleCount();
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    }
  }
  return path;
}
