import { test } from "node:test";
import assert from "node:assert/strict";
import { IntercomInboxApp } from "../IntercomInboxApp";
import type { DeliveryStatus } from "../../resend/EmailDeliverabilityService";

// The email-delivery section of the Intercom sidebar: an "I never got the
// email" conversation should show, without anyone asking, that Postiz mail to
// this person is being dropped, and let any teammate lift it.

type Component = { type: string; id?: string; text?: string; value?: string; label?: string };

const SUPPRESSED: DeliveryStatus = {
  email: "jamie@example.com",
  state: "suppressed",
  suppression: {
    id: "sup_1",
    email: "jamie@example.com",
    origin: "bounce",
    sourceId: "em_1",
    createdAt: new Date("2026-09-12T10:00:00Z"),
  },
  source: { id: "em_1", subject: "Activate your account", from: null, createdAt: null, lastEvent: "bounced" },
};

function harness(opts: { activated?: boolean | null; removeKind?: "removed" | "not_suppressed" } = {}) {
  const removals: Array<{ email: string; actor: string; conversationId?: string | null }> = [];
  const notes: Array<{ conversationId: string; text: string }> = [];
  const activations: string[] = [];
  const statuses: Record<string, DeliveryStatus> = { "jamie@example.com": SUPPRESSED };
  const delivery = {
    enabled: () => true,
    statusFor: async (emails: string[]) => emails.map((e) => statuses[e.toLowerCase()] ?? { email: e, state: "clear" as const }),
    statusOf: async (email: string) => statuses[email.toLowerCase()] ?? { email, state: "clear" as const },
    remove: async (email: string, actor: { name: string }, ctx: { conversationId?: string | null }) => {
      removals.push({ email, actor: actor.name, conversationId: ctx.conversationId });
      if ((opts.removeKind ?? "removed") === "not_suppressed") return { kind: "not_suppressed" as const };
      statuses[email.toLowerCase()] = { email, state: "clear" };
      return { kind: "removed" as const, previous: SUPPRESSED.state === "suppressed" ? SUPPRESSED.suppression : null };
    },
    resendActivation: async (email: string) => {
      activations.push(email);
      return { ok: true as const };
    },
  };
  const app = new IntercomInboxApp(
    { isIntercomPanelAdmin: () => false, intercomClientSecret: () => "s" } as never,
    { getLinkByConversationId: async () => null } as never,
    {} as never,
    {} as never,
    { findCustomersByEmail: async () => [] } as never,
    () => null,
    { pendingForConversation: async () => [] } as never,
    { getConversationContact: async () => ({ email: "jamie@example.com", name: "Jamie", contactId: "c_1" }) } as never,
    {
      resolve: async () => ({
        membershipId: "uo_1",
        userId: "usr_1",
        email: "jamie@example.com",
        orgId: "org_1",
        orgName: "Acme",
        role: "ADMIN",
        tier: "PRO",
        userActivated: opts.activated === undefined ? false : opts.activated,
      }),
    } as never,
    delivery as never,
    async (conversationId: string, text: string) => void notes.push({ conversationId, text })
  );
  const press = async (componentId: string | null, inputs: Record<string, string> = {}): Promise<Component[]> => {
    const body = {
      conversation: { id: 99 },
      admin: { id: 7, name: "Sam" },
      ...(componentId ? { component_id: componentId } : {}),
      input_values: inputs,
    };
    const out = (componentId ? await app.submit(body) : await app.initialize(body)) as {
      canvas: { content: { components: Component[] } };
    };
    return out.canvas.content.components;
  };
  return { press, removals, notes, activations };
}

const texts = (c: Component[]) => c.map((x) => x.text ?? "").join("\n");
const ids = (c: Component[]) => c.map((x) => x.id).filter(Boolean);

test("sidebar: the main card keeps to identity and warnings, with the detail behind buttons", async () => {
  const h = harness();
  const home = await h.press(null);
  const t = texts(home);
  assert.match(t, /Jamie · jamie@example\.com/);
  assert.match(t, /Postiz PRO · no Stripe customer/);
  assert.match(t, /⛔ Email suppressed: jamie@example\.com/);
  for (const id of ["nav:postiz", "nav:email", "nav:billing", "refresh:home"]) assert.ok(ids(home).includes(id), id);
  assert.ok(!ids(home).includes("nav:discord"), "no ticket, no Discord view");
  assert.ok(!ids(home).includes("open_panel"), "the Stripe panel is gone");
  assert.ok(!ids(home).includes("email_rm:0"), "actions live in the views");
});

test("sidebar: the email view shows a suppressed address with its cause and a Remove button", async () => {
  const h = harness();
  const c = await h.press("nav:email");
  const t = texts(c);
  assert.match(t, /Email delivery/);
  assert.match(t, /jamie@example\.com:\* ⛔ suppressed since 2026-09-12 \(hard bounce\), after "Activate your account"/);
  assert.ok(ids(c).includes("email_rm:0"));
  assert.ok(ids(c).includes("email_check_open"));
  assert.ok(ids(c).includes("nav:home"), "every view has a way back");
  // Deduplicated: the contact and the Postiz account share one address.
  assert.equal((t.match(/jamie@example\.com:\*/g) ?? []).length, 1);
});

test("sidebar: Remove asks first, then removes the RE-DERIVED address, notes it and offers activation", async () => {
  const h = harness();
  const confirm = await h.press("email_rm:0");
  assert.match(texts(confirm), /Remove jamie@example\.com from the suppression list\?/);
  assert.ok(ids(confirm).includes("email_rmx:0"));
  assert.equal(h.removals.length, 0, "the first press only asks");

  const done = await h.press("email_rmx:0");
  assert.deepEqual(h.removals, [{ email: "jamie@example.com", actor: "Sam", conversationId: "99" }]);
  assert.match(texts(done), /✅ Removed jamie@example\.com/);
  assert.match(texts(done), /not activated yet/);
  assert.ok(ids(done).includes("email_act:0"));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].text, /Sam removed jamie@example\.com from the Resend suppression list \(it was suppressed since 2026-09-12 \(hard bounce\)\)/);

  const sent = await h.press("email_act:0");
  assert.deepEqual(h.activations, ["jamie@example.com"]);
  assert.match(texts(sent), /sending a new activation email/);
});

test("sidebar: an activated account gets no activation offer; a stale index removes nothing", async () => {
  const h = harness({ activated: true });
  const done = await h.press("email_rmx:0");
  assert.ok(!ids(done).includes("email_act:0"));
  const stale = await h.press("email_rmx:5");
  assert.equal(h.removals.length, 1);
  assert.match(texts(stale), /no longer on this card/);
});

test("sidebar: any address can be checked through the input, and removed from there", async () => {
  const h = harness();
  const open = await h.press("email_check_open");
  assert.ok(ids(open).includes("email_query"));
  const bad = await h.press("email_check", { email_query: "not-an-email" });
  assert.match(texts(bad), /not an email address/);

  const checked = await h.press("email_check", { email_query: "jamie@example.com" });
  const input = checked.find((x) => x.id === "email_query");
  assert.equal(input?.value, "jamie@example.com", "the checked address rides the prefilled input to the next press");
  assert.ok(ids(checked).includes("email_rm_q"));

  await h.press("email_rm_q", { email_query: "jamie@example.com" });
  await h.press("email_rmx_q", { email_query: "jamie@example.com" });
  assert.deepEqual(
    h.removals.map((r) => r.email),
    ["jamie@example.com"]
  );
});
