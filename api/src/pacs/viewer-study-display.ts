import { birthKey } from '../study-identity';
import { LocalReadResponse, LocalReadSource } from '../emr-viewing/local-read';
import { consumerSource } from '../emr-viewing/consumer-read';
import type { SourceIdentity } from '../study-access.service';

const patientFields = ['name', 'id', 'sex', 'birth'] as const;
const examFields = ['date', 'desc', 'acc', 'modality'] as const;
type Field = typeof patientFields[number] | typeof examFields[number];

function displayValues(base: any, source: any, other: boolean) {
  const values = {} as Record<Field, string>;
  const over: Field[] = [];
  for (const key of [...patientFields, ...examFields]) {
    // A merged member uses the base patient's fields and its own list entry's examination columns.
    const fromBase = !other || patientFields.some(field => field === key);
    const row = fromBase ? base : source;
    const replacement = fromBase && !base.examUnavailable ? base.state.ov?.[key] : undefined;
    if (typeof replacement === 'string') {
      values[key] = replacement;
      over.push(key);
    } else if (key === 'acc' && !base.examUnavailable && row.orderAccession) {
      values.acc = row.orderAccession;
      over.push(key);
    } else values[key] = row[key] ?? '';
  }
  const birth = birthKey(values.birth), date = birthKey(values.date);
  const age = birth && date && date >= birth ? Math.floor((Number(date) - Number(birth)) / 10000) + 'Y' : '';
  // Prior navigation orders same-day exams by the original StudyTime, even after a Match.
  return { ...values, time: (other ? source : base).time ?? '', age, over };
}

/** Only metadata from the admitted exam selection reaches the viewer, including on the clinician route. */
export function viewerStudyDisplay(rows: any[], institutions: Map<string, string>, identities: Map<string, SourceIdentity>) {
  const studies = [], audit: LocalReadSource[] = [];
  for (const row of rows) {
    const ranges = row.group ? row.examScope.sources : [{ studyUid: row.uid, series: { mode: 'all', uids: [] } }];
    const sources = [];
    for (const { studyUid, series } of ranges) {
      const id = identities.get(studyUid)?.sourcePatientId, institution = institutions.get(studyUid);
      if (!institution || !id || institution + '|' + id !== row.sourcePatientKey) break;
      const member = row.sourceMetadata?.find(item => item.uid === studyUid);
      const other = row.group?.kind === 'merge' && studyUid !== row.uid;
      if (other && !member) break;
      sources.push({ studyUid, sourcePatientKey: row.sourcePatientKey, series, values: displayValues(row, member, other) });
    }
    if (!sources.length || sources.length !== ranges.length) continue;
    const path = ['studies', studies.length];
    audit.push(consumerSource('study-metadata', row.uid, row.state.institutionId, row.uid, null, path,
      identities.get(row.uid) ?? identities.get(sources[0].studyUid)));
    for (const [index, source] of sources.entries()) {
      const uid = source.studyUid;
      if (uid !== row.uid) audit.push(consumerSource('study-metadata', uid, institutions.get(uid), uid, null,
        [...path, 'displaySources', index], identities.get(uid)));
    }
    studies.push({ uid: row.uid, sourcePatientKey: row.sourcePatientKey, displaySources: sources, state: { rs: row.state.rs },
      examScope: row.examScope, examUnavailable: row.examUnavailable, examUnavailableKind: row.examUnavailableKind });
  }
  return new LocalReadResponse({ studies }, audit);
}
