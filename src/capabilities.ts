/**
 * Capability discovery — §5.1a of the v2 spec.
 *
 * Replaces the "run a curl probe from your phone" requirement. Each ingest
 * records which fields the upstream actually returned (non-null), plus any
 * reported tier/version. `GET /admin/capabilities` then answers "what can my
 * key see" with data the worker collected itself — and if the user later
 * upgrades a subscription, the override menu widens on the next sync with no
 * code change.
 */

export interface CapabilityObservation {
  source: string;
  field_path: string;
  available: boolean;
  tier_reported: string | null;
}

/**
 * Record which fields of an upstream response were present.
 *
 * Walks the top level plus one nesting level (pricing objects), because the
 * fields that matter for tier gating — pricing, context window, scores — sit
 * one level down. A value of null, undefined or '' counts as absent.
 */
export function observeFields(
  source: string,
  obj: Record<string, unknown>,
  prefix = '',
  version: string | null = null,
): CapabilityObservation[] {
  const out: CapabilityObservation[] = [];
  const seen = new Set<string>();

  const present = (v: unknown) => v !== null && v !== undefined && v !== '';

  for (const [key, value] of Object.entries(obj)) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source,
      field_path: `${prefix}${key}`,
      available: present(value),
      tier_reported: version,
    });

    // One level down for the fields that carry tier gating.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [sub, v] of Object.entries(value as Record<string, unknown>)) {
        const path = `${prefix}${key}.${sub}`;
        if (seen.has(path)) continue;
        seen.add(path);
        out.push({ source, field_path: path, available: present(v), tier_reported: version });
      }
    }
  }

  return out;
}

/**
 * Upsert observations into `source_capabilities`.
 *
 * Replace, don't accumulate: the point is the latest truth about a source, and
 * a field that stops arriving must be recorded as unavailable, not left
 * looking available in an old row.
 */
export async function persistCapabilities(
  db: D1Database,
  observations: CapabilityObservation[],
  observedAt: string,
): Promise<void> {
  if (observations.length === 0) return;

  const stmt = db.prepare(
    `INSERT INTO source_capabilities (source, field_path, available, tier_reported, observed_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(source, field_path) DO UPDATE SET
       available     = excluded.available,
       tier_reported = excluded.tier_reported,
       observed_at   = excluded.observed_at`,
  );

  await db.batch(
    observations.map((o) =>
      stmt.bind(o.source, o.field_path, o.available ? 1 : 0, o.tier_reported, observedAt),
    ),
  );
}