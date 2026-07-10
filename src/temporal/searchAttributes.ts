import type { Connection } from "@temporalio/client";
import { CUSTOM_SEARCH_ATTRIBUTES } from "./types";

// Idempotent custom search-attribute registration over the operator gRPC API
// (the same mTLS connection the client uses — no terminal access needed).
// Producers gate every attachment on a confirmed `ok`, so a failed or partial
// registration can never fail a workflow start.

// temporal.api.enums.v1.IndexedValueType — stable proto enum values, mapped
// locally because @temporalio/proto is not a direct dependency under pnpm's
// strict node_modules layout.
const INDEXED_VALUE_TYPE: Record<string, number> = {
  TEXT: 1,
  KEYWORD: 2,
  INT: 3,
  DOUBLE: 4,
  BOOL: 5,
  DATETIME: 6,
  KEYWORD_LIST: 7,
};

export interface SaEnsureResult {
  // Every custom attribute is present server-side with the right type.
  ok: boolean;
  added: string[];
  present: string[];
  // Exists server-side with a DIFFERENT type — never auto-fixed (SQL
  // visibility cannot re-type); surfaced in the panel for manual repair.
  mismatched: string[];
  // list/add RPC failure (e.g. operator API not permitted for this cert).
  error: string | null;
}

// list → add the missing subset → re-list to confirm. Never throws.
export async function ensureSearchAttributes(conn: Connection, namespace: string): Promise<SaEnsureResult> {
  const res: SaEnsureResult = { ok: false, added: [], present: [], mismatched: [], error: null };
  try {
    const listed = await conn.operatorService.listSearchAttributes({ namespace });
    const custom = listed.customAttributes ?? {};
    const missing: Record<string, number> = {};
    for (const key of CUSTOM_SEARCH_ATTRIBUTES) {
      const want = INDEXED_VALUE_TYPE[key.type];
      const have = custom[key.name];
      if (have == null) missing[key.name] = want;
      else if (Number(have) !== want) res.mismatched.push(key.name);
      else res.present.push(key.name);
    }
    if (Object.keys(missing).length > 0) {
      try {
        await conn.operatorService.addSearchAttributes({ namespace, searchAttributes: missing });
        res.added = Object.keys(missing);
      } catch (e) {
        // A concurrent registrar winning the race is success; verify below.
        if (!/already exists/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
      const verify = await conn.operatorService.listSearchAttributes({ namespace });
      const now = verify.customAttributes ?? {};
      for (const name of Object.keys(missing)) {
        if (now[name] == null) res.mismatched.push(name);
        else if (!res.added.includes(name)) res.added.push(name);
      }
    }
    res.ok = res.mismatched.length === 0;
    return res;
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
    return res;
  }
}

export function describeSaResult(r: SaEnsureResult | null): string {
  if (!r) return "not checked";
  if (r.error) return `error: ${r.error.slice(0, 120)}`;
  if (r.mismatched.length > 0) return `type mismatch: ${r.mismatched.join(", ")}`;
  const total = r.present.length + r.added.length;
  return r.added.length > 0 ? `ok (${total}, added ${r.added.join(", ")})` : `ok (${total})`;
}
