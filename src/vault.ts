/**
 * Nenu vault — mock implementation of the canonical store.
 *
 * This module is intentionally dependency-free so it can be unit-tested with
 * `node --experimental-strip-types` and so the same logic could back the
 * connector, the browser extension, and a desktop companion (one vault, many
 * clients). It models three things from the Nenu capability briefing:
 *
 *   1. Per-domain, per-field data with a sensitivity level and provenance.
 *   2. Server-side scope enforcement (the "vault gate"): a field can only be
 *      shared if the standing scope rule permits it. The host can only ever
 *      *further* restrict this, never widen it.
 *   3. An append-only audit ledger with provenance and one-tap revoke.
 *
 * High-sensitivity fields are never returned through the host. They follow the
 * briefing's "URL mode": the value stays in the vault and is shared via a
 * Nenu-hosted page, so it never passes through Claude/ChatGPT.
 */

export type Sensitivity = "low" | "medium" | "high";

/** Standing scope rule, mirroring the host's vocabulary (see briefing). */
export type ScopeRule = "always_allow" | "needs_approval" | "blocked";

export interface VaultField {
  key: string;
  label: string;
  /** Raw value. For `high` sensitivity this is NEVER sent through the host. */
  value: string;
  sensitivity: Sensitivity;
  /** Where Nenu learned this, for trust-proof and correction. */
  source: string;
  /** Standing scope rule for this field. */
  rule: ScopeRule;
  /** Whether it is pre-selected in the consent card by default. */
  defaultShare: boolean;
}

export interface VaultDomain {
  domain: string;
  title: string;
  fields: VaultField[];
}

/** A field as offered to the consent widget. High-sensitivity values masked. */
export interface CandidateField {
  key: string;
  label: string;
  /** Displayable value, or null when withheld (high sensitivity / URL mode). */
  value: string | null;
  masked: boolean;
  sensitivity: Sensitivity;
  source: string;
  rule: ScopeRule;
  defaultShare: boolean;
}

export interface CandidateBrief {
  domain: string;
  title: string;
  fields: CandidateField[];
}

export interface LedgerRecord {
  id: string;
  ts: string;
  domain: string;
  fieldKey: string;
  fieldLabel: string;
  source: string;
  /** "host" = value crossed to the model; "nenu_url" = shared via nenu.co. */
  channel: "host" | "nenu_url";
  revoked: boolean;
}

export interface ApprovedBrief {
  domain: string;
  fields: { key: string; label: string; value: string }[];
  /** Fields shared out-of-band via nenu.co (value not passed through host). */
  urlModeFields: { key: string; label: string }[];
  text: string;
  ledger: LedgerRecord[];
}

// --- Seed data ------------------------------------------------------------

const DOMAINS: Record<string, VaultDomain> = {
  travel: {
    domain: "travel",
    title: "Travel preferences",
    fields: [
      {
        key: "seat_preference",
        label: "Seat preference",
        value: "Aisle, exit row when available",
        sensitivity: "low",
        source: "Stated in chat, 2026-02-11",
        rule: "always_allow",
        defaultShare: true,
      },
      {
        key: "airline_status",
        label: "Airline loyalty status",
        value: "United 1K, Star Alliance Gold",
        sensitivity: "low",
        source: "Gmail receipt, 2026-01-03",
        rule: "always_allow",
        defaultShare: true,
      },
      {
        key: "dietary",
        label: "Dietary requirement",
        value: "Pescatarian, no shellfish",
        sensitivity: "medium",
        source: "Stated in chat, 2025-12-20",
        rule: "needs_approval",
        defaultShare: true,
      },
      {
        key: "home_airport",
        label: "Home airport",
        value: "RDU (Raleigh-Durham)",
        sensitivity: "medium",
        source: "Inferred from booking history",
        rule: "needs_approval",
        defaultShare: false,
      },
      {
        key: "passport_number",
        label: "Passport number",
        value: "•••••••• (stays in vault)",
        sensitivity: "high",
        source: "Uploaded document, 2025-11-30",
        rule: "needs_approval",
        defaultShare: false,
      },
      {
        key: "payment_card",
        label: "Saved payment card",
        value: "•••• 4242 (stays in vault)",
        sensitivity: "high",
        // Demonstrates the hard gate: blocked never reaches the host at all.
        source: "Aggregation (Yodlee)",
        rule: "blocked",
        defaultShare: false,
      },
    ],
  },
};

// In-memory ledger (process lifetime). A real vault persists this.
const LEDGER: LedgerRecord[] = [];

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

// --- API ------------------------------------------------------------------

export function listDomains(): string[] {
  return Object.keys(DOMAINS);
}

/**
 * Build the candidate brief offered to the consent widget. Applies the vault
 * gate: `blocked` fields are omitted entirely (they never appear in the host's
 * tool surface), and `high` sensitivity values are masked (URL mode).
 */
export function getCandidateBrief(domain: string): CandidateBrief {
  const d = DOMAINS[domain];
  if (!d) throw new Error(`Unknown domain: ${domain}`);

  const fields: CandidateField[] = d.fields
    .filter((f) => f.rule !== "blocked") // hard gate: blocked is never exposed
    .map((f) => {
      const withhold = f.sensitivity === "high"; // URL mode
      return {
        key: f.key,
        label: f.label,
        value: withhold ? null : f.value,
        masked: withhold,
        sensitivity: f.sensitivity,
        source: f.source,
        rule: f.rule,
        defaultShare: f.defaultShare,
      };
    });

  return { domain: d.domain, title: d.title, fields };
}

function getField(domain: string, key: string): VaultField | undefined {
  return DOMAINS[domain]?.fields.find((f) => f.key === key);
}

/**
 * Server-side scope enforcement + ledger write. Given the keys the user
 * approved in the widget, returns ONLY the permitted fields and logs each
 * share with provenance. Throws if a caller tries to approve a blocked field —
 * the vault gate is authoritative and cannot be widened by the host or widget.
 */
export function buildApprovedBrief(
  domain: string,
  approvedKeys: string[],
  edits: Record<string, string> = {},
): ApprovedBrief {
  const d = DOMAINS[domain];
  if (!d) throw new Error(`Unknown domain: ${domain}`);

  const fields: { key: string; label: string; value: string }[] = [];
  const urlModeFields: { key: string; label: string }[] = [];
  const records: LedgerRecord[] = [];

  for (const key of approvedKeys) {
    const f = getField(domain, key);
    if (!f) throw new Error(`Unknown field: ${domain}.${key}`);
    // Vault gate: a blocked field can never be shared, regardless of approval.
    if (f.rule === "blocked") {
      throw new Error(`Field ${domain}.${key} is blocked by vault scope`);
    }

    const isUrlMode = f.sensitivity === "high";
    const rec: LedgerRecord = {
      id: nextId("led"),
      ts: new Date().toISOString(),
      domain,
      fieldKey: f.key,
      fieldLabel: f.label,
      source: f.source,
      channel: isUrlMode ? "nenu_url" : "host",
      revoked: false,
    };
    LEDGER.push(rec);
    records.push(rec);

    if (isUrlMode) {
      // Value never passes through the host; shared via nenu.co redirect.
      urlModeFields.push({ key: f.key, label: f.label });
    } else {
      const value = edits[key] ?? f.value;
      fields.push({ key: f.key, label: f.label, value });
    }
  }

  const lines = fields.map((f) => `- ${f.label}: ${f.value}`);
  if (urlModeFields.length) {
    lines.push(
      `- ${urlModeFields
        .map((f) => f.label)
        .join(", ")}: shared securely via nenu.co (value withheld from this chat)`,
    );
  }
  const text =
    fields.length || urlModeFields.length
      ? `Approved ${d.title.toLowerCase()} to share:\n${lines.join("\n")}`
      : `The user declined to share any ${d.title.toLowerCase()}.`;

  return { domain, fields, urlModeFields, text, ledger: records };
}

export function getLedger(): LedgerRecord[] {
  return LEDGER.map((r) => ({ ...r }));
}

/** One-tap revoke. Marks the record revoked; returns true if found. */
export function revoke(id: string): boolean {
  const rec = LEDGER.find((r) => r.id === id);
  if (!rec) return false;
  rec.revoked = true;
  return true;
}

/** Test helper: reset ledger between runs. */
export function _resetLedger(): void {
  LEDGER.length = 0;
}
