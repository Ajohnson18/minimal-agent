import { randomUUID } from "node:crypto";

export type ManagedExecApprovalDecision = "allow-once" | "allow-always" | "deny";

export interface ManagedExecApprovalRequest {
  sessionId: string;
  userId?: string | null;
  agentId?: string | null;
  command: string;
  cwd: string;
  host: "sandbox" | "gateway" | "node";
  security: "deny" | "allowlist" | "full";
  ask: "on-miss" | "always";
  resolvedPath?: string | null;
}

export interface ManagedExecApprovalRecord {
  id: string;
  request: ManagedExecApprovalRequest;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
  decision?: ManagedExecApprovalDecision;
  reason?: string;
  resolvedBy?: string | null;
}

export interface ManagedExecApprovalOutcome {
  decision: ManagedExecApprovalDecision | null;
  reason?: string;
  resolvedBy?: string | null;
  timedOut?: boolean;
  errored?: boolean;
}

const RESOLVED_ENTRY_GRACE_MS = 15_000;

interface PendingEntry {
  record: ManagedExecApprovalRecord;
  resolve: (outcome: ManagedExecApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<ManagedExecApprovalOutcome>;
}

export class ExecApprovalManager {
  private pending = new Map<string, PendingEntry>();

  create(
    request: ManagedExecApprovalRequest,
    timeoutMs: number,
    id?: string | null,
  ): ManagedExecApprovalRecord {
    const now = Date.now();
    const resolvedId = id?.trim() ? id.trim() : randomUUID();
    return {
      id: resolvedId,
      request,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
  }

  register(
    record: ManagedExecApprovalRecord,
    timeoutMs: number,
  ): Promise<ManagedExecApprovalOutcome> {
    const existing = this.pending.get(record.id);
    if (existing) {
      throw new Error(`approval id '${record.id}' already exists`);
    }

    let resolver: ((outcome: ManagedExecApprovalOutcome) => void) | null = null;
    const promise = new Promise<ManagedExecApprovalOutcome>((resolve) => {
      resolver = resolve;
    });

    const entry: PendingEntry = {
      record,
      resolve: resolver!,
      timer: null as unknown as ReturnType<typeof setTimeout>,
      promise,
    };

    entry.timer = setTimeout(() => {
      record.resolvedAtMs = Date.now();
      record.reason = "approval timed out";
      entry.resolve({
        decision: null,
        reason: "approval timed out",
        timedOut: true,
      });
      this.scheduleDelete(record.id, entry);
    }, timeoutMs);
    entry.timer.unref();

    this.pending.set(record.id, entry);
    return promise;
  }

  awaitOutcome(recordId: string): Promise<ManagedExecApprovalOutcome> | null {
    return this.pending.get(recordId)?.promise ?? null;
  }

  resolve(
    recordId: string,
    decision: ManagedExecApprovalDecision,
    resolvedBy?: string | null,
    reason?: string,
  ): boolean {
    const entry = this.pending.get(recordId);
    if (!entry || entry.record.resolvedAtMs !== undefined) {
      return false;
    }

    clearTimeout(entry.timer);
    entry.record.resolvedAtMs = Date.now();
    entry.record.decision = decision;
    entry.record.reason = reason;
    entry.record.resolvedBy = resolvedBy ?? null;
    entry.resolve({ decision, reason, resolvedBy: resolvedBy ?? null });
    this.scheduleDelete(recordId, entry);
    return true;
  }

  fail(recordId: string, reason: string): boolean {
    const entry = this.pending.get(recordId);
    if (!entry || entry.record.resolvedAtMs !== undefined) {
      return false;
    }

    clearTimeout(entry.timer);
    entry.record.resolvedAtMs = Date.now();
    entry.record.reason = reason;
    entry.resolve({ decision: null, reason, errored: true });
    this.scheduleDelete(recordId, entry);
    return true;
  }

  getSnapshot(recordId: string): ManagedExecApprovalRecord | null {
    return this.pending.get(recordId)?.record ?? null;
  }

  reset(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }

  private scheduleDelete(recordId: string, entry: PendingEntry): void {
    setTimeout(() => {
      if (this.pending.get(recordId) === entry) {
        this.pending.delete(recordId);
      }
    }, RESOLVED_ENTRY_GRACE_MS).unref();
  }
}
