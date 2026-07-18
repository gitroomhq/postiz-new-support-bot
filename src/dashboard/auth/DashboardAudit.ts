import { PrismaClient, DashboardAuditLog } from "../../generated/prisma/client";
import { log } from "../../util/logger";

const auditLog = log.child("dashboard:audit");

// Append-only dashboard audit trail (dashboard_audit_log). Auth lifecycle
// events + every mutating action land here; the Security page reads it back
// as the recent-activity feed. Best-effort by design — an audit write must
// never fail the action it describes (the log line is the fallback).

export interface DashboardAuditEvent {
  actorId: string;
  actorName: string;
  kind: "auth" | "action" | "admin";
  action: string; // e.g. "login.passkey", "session.revoke", "charge.refund_full"
  targetId?: string | null;
  summary: string;
  outcome: "ok" | "denied" | "failed";
  ip?: string | null;
  sessionIdHash?: string | null;
}

export class DashboardAudit {
  constructor(private prisma: PrismaClient) {}

  async record(e: DashboardAuditEvent): Promise<void> {
    try {
      await this.prisma.dashboardAuditLog.create({
        data: {
          actorId: e.actorId,
          actorName: e.actorName,
          kind: e.kind,
          action: e.action,
          targetId: e.targetId ?? null,
          summary: e.summary.slice(0, 500),
          outcome: e.outcome,
          ip: e.ip?.slice(0, 60) ?? null,
          sessionIdHash: e.sessionIdHash ?? null,
        },
      });
    } catch (err) {
      auditLog.warn("dashboard audit write failed", {
        "audit.action": e.action,
        "error.message": err instanceof Error ? err.message : String(err),
      });
    }
  }

  async recent(limit = 20, actorId?: string): Promise<DashboardAuditLog[]> {
    return this.prisma.dashboardAuditLog.findMany({
      where: actorId ? { actorId } : undefined,
      orderBy: { at: "desc" },
      take: limit,
    });
  }
}
