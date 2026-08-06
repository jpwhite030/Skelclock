import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toOdooDatetime, toOdooDate, fromOdooDatetime } from './client.js';
import { buildAttendanceBlocks, type SegmentForPush } from './attendance-blocks.js';
import { MockOdooAdapter, DEMO_EMPLOYEE } from './mock-adapter.js';
import { buildMapping, jobReadFields, mapJobStatus } from './mapping.js';
import { validateBlocks } from './adapter.js';
import { createOdooAdapter } from './factory.js';

// --- datetime conversion ----------------------------------------------------
// Getting this wrong shifts every shift in the system by 10 or 11 hours.

test('AEST times convert to naive UTC for Odoo', () => {
  assert.equal(toOdooDatetime('2026-08-04T06:30:00+10:00'), '2026-08-03 20:30:00');
});

test('UTC times pass through unchanged', () => {
  assert.equal(toOdooDatetime('2026-08-04T06:30:00Z'), '2026-08-04 06:30:00');
});

test('AEDT (daylight saving) converts correctly', () => {
  // NSW is +11 in January.
  assert.equal(toOdooDatetime('2026-01-15T06:30:00+11:00'), '2026-01-14 19:30:00');
});

test('Odoo datetimes round-trip', () => {
  const original = '2026-08-04T06:30:00.000Z';
  assert.equal(fromOdooDatetime(toOdooDatetime(original)), '2026-08-04T06:30:00Z');
});

test('toOdooDate takes the UTC calendar day', () => {
  assert.equal(toOdooDate('2026-08-04T06:30:00+10:00'), '2026-08-03');
});

test('invalid datetimes are rejected rather than silently sent', () => {
  assert.throws(() => toOdooDatetime('not a date'));
});

// --- attendance block building ---------------------------------------------

function seg(
  id: string,
  startTime: string,
  endTime: string | null,
  segmentType: SegmentForPush['segmentType'] = 'work',
  isPaid = true,
): SegmentForPush {
  return { id, segmentType, startTime, endTime, isPaid };
}

test('a straight shift becomes one attendance record', () => {
  const { blocks } = buildAttendanceBlocks([
    seg('s1', '2026-08-04T06:00:00Z', '2026-08-04T14:00:00Z'),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.checkIn, '2026-08-04T06:00:00Z');
  assert.equal(blocks[0]!.checkOut, '2026-08-04T14:00:00Z');
});

test('changing job mid-shift does not split the attendance record', () => {
  // hr.attendance has nowhere to put the job, so two contiguous work segments
  // are one attendance. The job split survives on the analytic lines.
  const { blocks } = buildAttendanceBlocks([
    seg('s1', '2026-08-04T06:00:00Z', '2026-08-04T09:00:00Z'),
    seg('s2', '2026-08-04T09:00:00Z', '2026-08-04T14:00:00Z'),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.checkIn, '2026-08-04T06:00:00Z');
  assert.equal(blocks[0]!.checkOut, '2026-08-04T14:00:00Z');
});

test('an unpaid break splits the day so Odoo worked_hours equals paid hours', () => {
  const { blocks } = buildAttendanceBlocks([
    seg('s1', '2026-08-04T06:00:00Z', '2026-08-04T09:00:00Z'),
    seg('s2', '2026-08-04T09:00:00Z', '2026-08-04T09:30:00Z', 'break', false),
    seg('s3', '2026-08-04T09:30:00Z', '2026-08-04T14:00:00Z'),
  ]);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.checkOut, '2026-08-04T09:00:00Z');
  assert.equal(blocks[1]!.checkIn, '2026-08-04T09:30:00Z');

  const totalHours = blocks.reduce(
    (sum, b) => sum + (Date.parse(b.checkOut) - Date.parse(b.checkIn)) / 3_600_000,
    0,
  );
  assert.equal(totalHours, 7.5); // 8h door-to-door, 30m unpaid
});

test('a paid break does not split the attendance record', () => {
  const { blocks } = buildAttendanceBlocks([
    seg('s1', '2026-08-04T06:00:00Z', '2026-08-04T09:00:00Z'),
    seg('s2', '2026-08-04T09:00:00Z', '2026-08-04T09:15:00Z', 'break', true),
    seg('s3', '2026-08-04T09:15:00Z', '2026-08-04T14:00:00Z'),
  ]);
  assert.equal(blocks.length, 1);
});

test('travel time is paid and stays inside the block', () => {
  const { blocks } = buildAttendanceBlocks([
    seg('s1', '2026-08-04T06:00:00Z', '2026-08-04T09:00:00Z'),
    seg('s2', '2026-08-04T09:00:00Z', '2026-08-04T09:30:00Z', 'travel', true),
    seg('s3', '2026-08-04T09:30:00Z', '2026-08-04T14:00:00Z'),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.checkOut, '2026-08-04T14:00:00Z');
});

test('an open segment is never pushed to Odoo', () => {
  const { blocks, skipped } = buildAttendanceBlocks([
    seg('s1', '2026-08-04T06:00:00Z', null),
  ]);
  assert.equal(blocks.length, 0);
  assert.equal(skipped[0]!.reason, 'segment is still open');
});

test('a gap in the record does not get paid for', () => {
  // Two work segments with an unexplained hour between them.
  const { blocks } = buildAttendanceBlocks([
    seg('s1', '2026-08-04T06:00:00Z', '2026-08-04T09:00:00Z'),
    seg('s2', '2026-08-04T10:00:00Z', '2026-08-04T14:00:00Z'),
  ]);
  assert.equal(blocks.length, 2);
  const totalHours = blocks.reduce(
    (sum, b) => sum + (Date.parse(b.checkOut) - Date.parse(b.checkIn)) / 3_600_000,
    0,
  );
  assert.equal(totalHours, 7);
});

test('segments arriving out of order are sorted before building', () => {
  const { blocks } = buildAttendanceBlocks([
    seg('s3', '2026-08-04T09:30:00Z', '2026-08-04T14:00:00Z'),
    seg('s1', '2026-08-04T06:00:00Z', '2026-08-04T09:00:00Z'),
    seg('s2', '2026-08-04T09:00:00Z', '2026-08-04T09:30:00Z', 'break', false),
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.checkIn, '2026-08-04T06:00:00Z');
});

test('blocks with reversed times are rejected before reaching Odoo', () => {
  assert.throws(() =>
    validateBlocks([
      { localRef: 's1', checkIn: '2026-08-04T14:00:00Z', checkOut: '2026-08-04T06:00:00Z' },
    ]),
  );
});

// --- push idempotency -------------------------------------------------------
// This is acceptance criterion 8. It has to hold under every retry shape.

const BLOCKS = [
  { localRef: 's1', checkIn: '2026-08-04T06:00:00Z', checkOut: '2026-08-04T14:00:00Z' },
];

test('pushing the same day twice with known ids updates rather than duplicates', async () => {
  const odoo = new MockOdooAdapter();

  const first = await odoo.pushAttendance({
    employeeOdooId: DEMO_EMPLOYEE.odooId,
    blocks: BLOCKS,
  });
  assert.equal(first.created, 1);

  const second = await odoo.pushAttendance({
    employeeOdooId: DEMO_EMPLOYEE.odooId,
    blocks: BLOCKS,
    knownOdooIds: first.odooIds,
  });

  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.equal(odoo.attendanceCount(), 1);
});

test('a retry that lost our record of the Odoo id still does not duplicate', async () => {
  // The nasty case: the push succeeded but the response never reached us, so
  // we retry with no knownOdooIds. Without lost-id recovery this doubles pay.
  const odoo = new MockOdooAdapter();

  await odoo.pushAttendance({ employeeOdooId: DEMO_EMPLOYEE.odooId, blocks: BLOCKS });
  const retry = await odoo.pushAttendance({
    employeeOdooId: DEMO_EMPLOYEE.odooId,
    blocks: BLOCKS,
  });

  assert.equal(retry.created, 0);
  assert.equal(retry.updated, 1);
  assert.equal(odoo.attendanceCount(), 1);
});

test('a record deleted in Odoo is recreated, not written to a dead id', async () => {
  const odoo = new MockOdooAdapter();
  const first = await odoo.pushAttendance({
    employeeOdooId: DEMO_EMPLOYEE.odooId,
    blocks: BLOCKS,
  });

  odoo.deleteAttendance(first.odooIds.s1!);

  const again = await odoo.pushAttendance({
    employeeOdooId: DEMO_EMPLOYEE.odooId,
    blocks: BLOCKS,
    knownOdooIds: first.odooIds,
  });

  assert.equal(again.created, 1);
  assert.equal(odoo.attendanceCount(), 1);
});

test('corrected hours overwrite the existing Odoo record in place', async () => {
  const odoo = new MockOdooAdapter();
  const first = await odoo.pushAttendance({
    employeeOdooId: DEMO_EMPLOYEE.odooId,
    blocks: BLOCKS,
  });

  // Supervisor fixes a missed clock-out: 14:00 becomes 15:30.
  await odoo.pushAttendance({
    employeeOdooId: DEMO_EMPLOYEE.odooId,
    blocks: [{ ...BLOCKS[0]!, checkOut: '2026-08-04T15:30:00Z' }],
    knownOdooIds: first.odooIds,
  });

  const records = odoo.attendanceRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.check_out, '2026-08-04 15:30:00');
});

test('two employees on the same site at the same time get their own records', async () => {
  const odoo = new MockOdooAdapter();
  await odoo.pushAttendance({ employeeOdooId: 1042, blocks: BLOCKS });
  await odoo.pushAttendance({ employeeOdooId: 1043, blocks: BLOCKS });
  assert.equal(odoo.attendanceCount(), 2);
});

test('a failing Odoo surfaces an error the office can act on', async () => {
  const odoo = new MockOdooAdapter({ failureMode: 'always' });
  await assert.rejects(
    () => odoo.pushAttendance({ employeeOdooId: 1042, blocks: BLOCKS }),
    /hr\.attendance/,
  );
});

test('a transient failure succeeds on retry with no duplicate', async () => {
  const odoo = new MockOdooAdapter({ failureMode: 'first_n', failCount: 2 });

  await assert.rejects(() => odoo.pushAttendance({ employeeOdooId: 1042, blocks: BLOCKS }));
  await assert.rejects(() => odoo.pushAttendance({ employeeOdooId: 1042, blocks: BLOCKS }));

  const third = await odoo.pushAttendance({ employeeOdooId: 1042, blocks: BLOCKS });
  assert.equal(third.created, 1);
  assert.equal(odoo.attendanceCount(), 1);
});

// --- mapping ----------------------------------------------------------------

test('the job model preset is swappable without touching anything above', () => {
  assert.equal(buildMapping({ jobModel: 'project.project' }).job.model, 'project.project');
  assert.equal(buildMapping({ jobModel: 'sale.order' }).job.model, 'sale.order');
  assert.equal(buildMapping({ jobModel: 'x_skelscaff_job' }).job.model, 'x_skelscaff_job');
});

test('unset job model falls back to the custom convention', () => {
  assert.equal(buildMapping().job.model, 'x_skelscaff_job');
});

test('job read fields are deduplicated and drop unmapped columns', () => {
  const { job } = buildMapping({ jobModel: 'project.project' });
  const fields = jobReadFields(job);
  assert.equal(new Set(fields).size, fields.length);
  assert.ok(fields.includes('id'));
  assert.ok(!fields.includes('null'));
});

test('an unrecognised Odoo status falls back to active rather than hiding a job', () => {
  const { job } = buildMapping({ jobModel: 'sale.order' });
  assert.equal(mapJobStatus(job, 'sale'), 'active');
  assert.equal(mapJobStatus(job, 'cancel'), 'cancelled');
  assert.equal(mapJobStatus(job, 'something_new_in_odoo_19'), 'active');
});

// --- factory ----------------------------------------------------------------

test('a clone with no credentials runs against fixtures', () => {
  assert.equal(createOdooAdapter({}).mode, 'mock');
});

test('live mode without credentials fails loudly and says which are missing', () => {
  assert.throws(
    () => createOdooAdapter({ ODOO_MODE: 'live', ODOO_URL: 'https://x.odoo.com' }),
    /ODOO_DB, ODOO_USERNAME, ODOO_API_KEY/,
  );
});

test('live mode with full credentials builds the live adapter', () => {
  const adapter = createOdooAdapter({
    ODOO_MODE: 'live',
    ODOO_URL: 'https://skelscaff.odoo.com',
    ODOO_DB: 'skelscaff',
    ODOO_USERNAME: 'api@skelscaff.com.au',
    ODOO_API_KEY: 'key',
    ODOO_JOB_MODEL: 'project.project',
  });
  assert.equal(adapter.mode, 'live');
});
