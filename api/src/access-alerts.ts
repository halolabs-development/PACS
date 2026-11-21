/**
 * Access Alerts: one account opening many different studies in a short time.
 *
 * Input rows are what emr_access.alert_entries decided counts as opening a study (one row per counted event and
 * study, within one institution's recorded scope and period). This file decides only the time rule:
 * an alert is a span in which one account opened at least `studies` different studies with the first and the last
 * of them at most `minutes` apart. Qualifying windows of the same account that share an entry are one alert;
 * windows that share none are separate alerts. Every count is recounted over the alert's own span.
 *
 * The threshold is a site setting, KIN_ACCESS_ALERT_THRESHOLD = "<studies>/<minutes>". No requirement or
 * product measurement gives a number; the default 50/10 keeps a reader who opens a study with a few comparisons
 * from raising an alert.
 */
export interface AlertThreshold { studies: number; minutes: number }
export const ALERT_THRESHOLD_DEFAULT: AlertThreshold = Object.freeze({ studies: 50, minutes: 10 });
/** Above this many counted rows the period is refused rather than judged on part of it. */
export const ALERT_ROW_CAP = 200000;

/**
 * Unset is the default. docker-compose.yml passes an unset KIN_ACCESS_ALERT_THRESHOLD as the empty string
 * (`${KIN_ACCESS_ALERT_THRESHOLD:-}`), so the empty string is unset too. Anything else must be exactly two positive
 * whole numbers; otherwise null and the alert read is refused, never answered under a guessed threshold.
 */
export function alertThreshold(raw: string | undefined): AlertThreshold | null {
  if (raw === undefined || raw === '') return ALERT_THRESHOLD_DEFAULT;
  const match = /^([1-9]\d{0,5})\/([1-9]\d{0,5})$/.exec(raw);
  if (!match) return null;
  return Object.freeze({ studies: Number(match[1]), minutes: Number(match[2]) });
}

export interface AlertRow {
  entryId: string;
  sequence: bigint | number | string;
  eventId: string;
  occurredAt: Date;
  account: string;
  studyId: string;
}

export interface AccessAlert {
  account: string;
  firstAt: string;
  lastAt: string;
  studies: number;
  events: number;
  /** The entry whose study first made the span reach the threshold. */
  evidenceEntryId: string;
}

const order = (a: AlertRow, b: AlertRow) => {
  const time = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (time) return time;
  const sa = BigInt(a.sequence), sb = BigInt(b.sequence);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.studyId < b.studyId ? -1 : a.studyId > b.studyId ? 1 : 0;
};

function span(rows: readonly AlertRow[], from: number, to: number, evidence: AlertRow): AccessAlert {
  const part = rows.slice(from, to + 1);
  return { account: rows[from].account, firstAt: rows[from].occurredAt.toISOString(), lastAt: rows[to].occurredAt.toISOString(),
    studies: new Set(part.map(row => row.studyId)).size, events: new Set(part.map(row => row.eventId)).size,
    evidenceEntryId: evidence.entryId };
}

/** Alerts of one period, ordered by first time then account. */
export function accessAlerts(input: readonly AlertRow[], threshold: AlertThreshold): AccessAlert[] {
  const width = threshold.minutes * 60000;
  const accounts = new Map<string, AlertRow[]>();
  for (const row of input) {
    const list = accounts.get(row.account);
    if (list) list.push(row); else accounts.set(row.account, [row]);
  }
  const alerts: AccessAlert[] = [];
  for (const unsorted of accounts.values()) {
    const rows = [...unsorted].sort(order);
    const inWindow = new Map<string, number>();
    let left = 0, open: { from: number; to: number; evidence: AlertRow } | null = null;
    for (let right = 0; right < rows.length; right++) {
      const time = rows[right].occurredAt.getTime();
      inWindow.set(rows[right].studyId, (inWindow.get(rows[right].studyId) ?? 0) + 1);
      while (time - rows[left].occurredAt.getTime() > width) {
        const study = rows[left].studyId, count = inWindow.get(study)! - 1;
        if (count) inWindow.set(study, count); else inWindow.delete(study);
        left++;
      }
      if (inWindow.size < threshold.studies) continue;
      if (open && left <= open.to) open.to = right;
      else {
        if (open) alerts.push(span(rows, open.from, open.to, open.evidence));
        open = { from: left, to: right, evidence: rows[right] };
      }
    }
    if (open) alerts.push(span(rows, open.from, open.to, open.evidence));
  }
  return alerts.sort((a, b) => a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : a.account < b.account ? -1 : a.account > b.account ? 1 : 0);
}
