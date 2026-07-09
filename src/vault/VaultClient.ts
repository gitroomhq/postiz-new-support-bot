// Thrown for non-2xx Vault responses so VaultService can classify state by
// status: 403 → denied (bad/revoked token), 400 on Transit → permanent per-item
// failure, everything else (5xx, sealed 503) → down. The message carries the
// status and Vault's errors[] only — never the token or request bodies, which
// can contain plaintext secrets.
export class VaultHttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "VaultHttpError";
  }
}

export interface VaultConnection {
  addr: string; // e.g. https://vault.example.com:8200
  token: string;
  kvMount: string; // KV v2 secrets engine mount, e.g. "kv"
  kvBasePath: string; // path prefix under the mount, e.g. "support-bot"
  transitMount: string; // Transit engine mount, e.g. "transit"
  transitKey: string; // Transit key name, e.g. "support-bot"
}

// Dumb HTTP client for the exact Vault surface the bot uses: KV v2 get/put/
// delete, Transit encrypt/decrypt (single + batch), sys/health and token
// lookup-self. Stateless and retry-free by design — VaultService owns the
// up/down state machine and recovery. Every call has a hard timeout so a hung
// Vault can never freeze a caller (same rule as IntercomClient).
export class VaultClient {
  private static readonly REQUEST_TIMEOUT_MS = 5_000;

  constructor(private conn: VaultConnection) {}

  private url(path: string): string {
    return `${this.conn.addr.replace(/\/+$/, "")}/v1/${path}`;
  }

  // Mounts/paths come from /config free text; encode each segment so a stray
  // space or unicode char becomes a clean 404 instead of a mangled request.
  private encodePath(p: string): string {
    return p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  }

  private kvPath(kind: "data" | "metadata", path: string): string {
    return `${this.encodePath(this.conn.kvMount)}/${kind}/${this.encodePath(`${this.conn.kvBasePath}/${path}`)}`;
  }

  private transitPath(op: "encrypt" | "decrypt"): string {
    return `${this.encodePath(this.conn.transitMount)}/${op}/${encodeURIComponent(this.conn.transitKey)}`;
  }

  // Low-level call that never throws on HTTP status — the Transit batch
  // endpoints can return per-item errors alongside a 400, and sys/health
  // reports via the status code itself.
  private async requestFull(
    method: string,
    path: string,
    body?: unknown,
    opts?: { unauthenticated?: boolean }
  ): Promise<{ status: number; data: unknown }> {
    const response = await fetch(this.url(path), {
      method,
      headers: {
        ...(opts?.unauthenticated ? {} : { "X-Vault-Token": this.conn.token }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(VaultClient.REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    return { status: response.status, data };
  }

  private static errorDetail(data: unknown, fallback: string): string {
    const errors = (data as { errors?: string[] } | undefined)?.errors;
    return errors?.filter(Boolean).join("; ") || fallback;
  }

  private async request<T>(method: string, path: string, body: unknown, what: string): Promise<T> {
    const { status, data } = await this.requestFull(method, path, body);
    if (status < 200 || status >= 300) {
      throw new VaultHttpError(status, `Vault ${what} ${status}: ${VaultClient.errorDetail(data, `HTTP ${status}`)}`);
    }
    return data as T;
  }

  // GET sys/health reports via the HTTP status (200 usable, 501 uninitialized,
  // 503 sealed); the query flags make standby nodes answer 200 too. This is the
  // one unauthenticated endpoint — it works even with a revoked token.
  async health(): Promise<{ ok: boolean; initialized: boolean; sealed: boolean }> {
    const { status, data } = await this.requestFull(
      "GET",
      "sys/health?standbyok=true&perfstandbyok=true",
      undefined,
      { unauthenticated: true }
    );
    const body = (data ?? {}) as { initialized?: boolean; sealed?: boolean };
    return {
      ok: status === 200,
      initialized: body.initialized ?? status !== 501,
      sealed: body.sealed ?? status === 503,
    };
  }

  async lookupSelf(): Promise<{ displayName: string | null; policies: string[]; ttlSeconds: number }> {
    const data = await this.request<{ data?: { display_name?: string; policies?: string[]; ttl?: number } }>(
      "GET",
      "auth/token/lookup-self",
      undefined,
      "token lookup"
    );
    return {
      displayName: data.data?.display_name || null,
      policies: data.data?.policies ?? [],
      ttlSeconds: data.data?.ttl ?? 0,
    };
  }

  // Latest-version read of one KV v2 entry. null = path doesn't exist (or its
  // latest version was deleted) — a normal state, not an error.
  async kvGet(path: string): Promise<Record<string, string> | null> {
    try {
      const data = await this.request<{ data?: { data?: Record<string, string> } }>(
        "GET",
        this.kvPath("data", path),
        undefined,
        `kv get ${path}`
      );
      return data.data?.data ?? null;
    } catch (e) {
      if (e instanceof VaultHttpError && e.status === 404) return null;
      throw e;
    }
  }

  async kvPut(path: string, data: Record<string, string>): Promise<void> {
    await this.request("POST", this.kvPath("data", path), { data }, `kv put ${path}`);
  }

  // Metadata delete removes every version plus the entry itself (a plain data
  // delete would only soft-delete the latest version).
  async kvDelete(path: string): Promise<void> {
    try {
      await this.request("DELETE", this.kvPath("metadata", path), undefined, `kv delete ${path}`);
    } catch (e) {
      if (e instanceof VaultHttpError && e.status === 404) return;
      throw e;
    }
  }

  // Transit ciphertexts come back in Vault's native `vault:v<N>:…` envelope and
  // are stored verbatim (see crypto.ts isTransitCiphertext).
  async transitEncrypt(plaintext: string): Promise<string> {
    const data = await this.request<{ data?: { ciphertext?: string } }>(
      "POST",
      this.transitPath("encrypt"),
      { plaintext: Buffer.from(plaintext, "utf8").toString("base64") },
      "transit encrypt"
    );
    const ct = data.data?.ciphertext;
    if (!ct) throw new VaultHttpError(500, "Vault transit encrypt 500: missing ciphertext in response");
    return ct;
  }

  async transitDecrypt(ciphertext: string): Promise<string> {
    const data = await this.request<{ data?: { plaintext?: string } }>(
      "POST",
      this.transitPath("decrypt"),
      { ciphertext },
      "transit decrypt"
    );
    const pt = data.data?.plaintext;
    if (pt == null) throw new VaultHttpError(500, "Vault transit decrypt 500: missing plaintext in response");
    return Buffer.from(pt, "base64").toString("utf8");
  }

  // Batch variants. Vault reports per-item failures inside batch_results (and
  // may pair them with an overall 400), so: batch_results present → map each
  // slot, null for failed items; no batch_results and non-2xx → real error.
  async transitEncryptBatch(plaintexts: string[]): Promise<(string | null)[]> {
    if (plaintexts.length === 0) return [];
    const { status, data } = await this.requestFull("POST", this.transitPath("encrypt"), {
      batch_input: plaintexts.map((p) => ({ plaintext: Buffer.from(p, "utf8").toString("base64") })),
    });
    const results = (data as { data?: { batch_results?: { ciphertext?: string; error?: string }[] } } | undefined)
      ?.data?.batch_results;
    if (!results) {
      if (status < 200 || status >= 300) {
        throw new VaultHttpError(status, `Vault transit encrypt batch ${status}: ${VaultClient.errorDetail(data, `HTTP ${status}`)}`);
      }
      return plaintexts.map(() => null);
    }
    return plaintexts.map((_, i) => results[i]?.ciphertext ?? null);
  }

  async transitDecryptBatch(ciphertexts: string[]): Promise<(string | null)[]> {
    if (ciphertexts.length === 0) return [];
    const { status, data } = await this.requestFull("POST", this.transitPath("decrypt"), {
      batch_input: ciphertexts.map((c) => ({ ciphertext: c })),
    });
    const results = (data as { data?: { batch_results?: { plaintext?: string; error?: string }[] } } | undefined)
      ?.data?.batch_results;
    if (!results) {
      if (status < 200 || status >= 300) {
        throw new VaultHttpError(status, `Vault transit decrypt batch ${status}: ${VaultClient.errorDetail(data, `HTTP ${status}`)}`);
      }
      return ciphertexts.map(() => null);
    }
    return ciphertexts.map((_, i) => {
      const b64 = results[i]?.plaintext;
      return b64 ? Buffer.from(b64, "base64").toString("utf8") : null;
    });
  }
}
