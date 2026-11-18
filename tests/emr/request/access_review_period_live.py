"""Access Review over practical periods on B2's owned synthetic PostgreSQL install (about 170,000 and 1,020,000 entries).

The ledger is filled with synthetic copies of entries the test writes itself; never reads an application database.
Disk storage: the larger ledger does not fit the fixture's default memory file systems.
"""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
from pg_ledger_restore_test import PgLedgerFixture

# The definition this one replaced: the reference answer, and the defect it must no longer show.
PREVIOUS = ROOT / 'api/prisma/migrations/20261025120000_access_review/migration.sql'


class AccessReviewPeriodLive(PgLedgerFixture):
    disk_storage = True
    pg_memory = '1g'

    def test_practical_periods(self):
        driver = ROOT / 'tests/emr/request/access_review_period_pg_test.cjs'
        evidence = ROOT / 'tmp/access-review-period' / self.token
        if self.image:
            command = ['docker', 'run', '--name', self.container + '-node', '--label', 'kin.b2r=' + self.token,
                       '--network', self.network,
                       '--mount', 'type=bind,source=' + str(driver) + ',target=/app/access-review-period.cjs,readonly',
                       '--mount', 'type=bind,source=' + str(PREVIOUS) + ',target=/reference/previous.sql,readonly',
                       '-e', 'KIN_ACCESS_REVIEW_BUILD=/app/dist', '-e', 'KIN_ACCESS_REVIEW_PREVIOUS=/reference/previous.sql',
                       '-e', 'DATABASE_URL=' + self.runtime_url, '-e', 'KIN_B2R_WITNESS_URL=' + self.witness_url,
                       '-e', 'KIN_B2R_SPOOL=/tmp/access-review-period-spool',
                       self.image, 'node', '/app/access-review-period.cjs']
            env = None
        else:
            command = [os.environ['KIN_B2R_NODE'], str(driver)]
            env = {**os.environ, 'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
                   'KIN_B2R_SPOOL': str(evidence / 'spool'), 'NODE_PATH': str(ROOT / 'api/node_modules'),
                   'KIN_ACCESS_REVIEW_BUILD': str(ROOT / 'api/dist'), 'KIN_ACCESS_REVIEW_PREVIOUS': str(PREVIOUS)}
        output = self.run_node_case(command, evidence, env=env, timeout=1200)
        self.assertIn('PASS: Access Review over a day', output)


if __name__ == '__main__':
    unittest.main(verbosity=2)
