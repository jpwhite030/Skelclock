import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseQuery, partsFromGuras, queryLadder } from './geocode.js';

// Every case below is a real string: either what a person types into the site
// search, or what GURAS actually returns for a Wollongong address.

test('normaliseQuery expands the street types people actually type', () => {
  assert.equal(normaliseQuery('14 kembla st wollongong'), '14 KEMBLA STREET WOLLONGONG');
  assert.equal(normaliseQuery('12 Robsons Rd, Keiraville'), '12 ROBSONS ROAD KEIRAVILLE');
  assert.equal(normaliseQuery('3 Beach Pde Wollongong'), '3 BEACH PARADE WOLLONGONG');
  assert.equal(normaliseQuery('9 Hillcrest Cres Figtree'), '9 HILLCREST CRESCENT FIGTREE');
});

test('normaliseQuery drops the state and postcode GURAS does not store', () => {
  assert.equal(
    normaliseQuery('63 Kembla Street, Wollongong NSW 2500'),
    '63 KEMBLA STREET WOLLONGONG',
  );
  assert.equal(normaliseQuery('5 Gipps St Wollongong 2500'), '5 GIPPS STREET WOLLONGONG');
});

test('normaliseQuery keeps unit numbers, which GURAS stores with the slash', () => {
  assert.equal(normaliseQuery('1/63 kembla st wollongong'), '1/63 KEMBLA STREET WOLLONGONG');
});

test('normaliseQuery strips anything that could escape the where clause', () => {
  // The result is interpolated into an ArcGIS `where` — a surviving quote
  // would be an injection into someone else's database.
  const dirty = normaliseQuery("63 Kembla' OR 1=1 -- Street Wollongong");
  assert.ok(!dirty.includes("'"), `quote survived: ${dirty}`);
  assert.ok(!dirty.includes('='), `equals survived: ${dirty}`);
  assert.match(dirty, /^[A-Z0-9/\- ]*$/);
});

test('normaliseQuery leaves a leading four-digit number alone', () => {
  // 1234 Princes Highway is a house number, not a postcode — the rule only
  // discards a four-digit run once a street has already been banked.
  assert.equal(
    normaliseQuery('1234 Princes Hwy Yallah'),
    '1234 PRINCES HIGHWAY YALLAH',
  );
});

test('queryLadder loosens from the suburb inwards and stops at three words', () => {
  assert.deepEqual(queryLadder('14 KEMBLA STREET WOLLONGONG NORTH'), [
    '14 KEMBLA STREET WOLLONGONG NORTH',
    '14 KEMBLA STREET WOLLONGONG',
    '14 KEMBLA STREET',
  ]);
  // Never loosens to "14 KEMBLA", which would match a different suburb's street.
  assert.deepEqual(queryLadder('14 KEMBLA STREET'), ['14 KEMBLA STREET']);
  assert.deepEqual(queryLadder('KEMBLA STREET'), ['KEMBLA STREET']);
  assert.deepEqual(queryLadder(''), []);
});

test('partsFromGuras splits a real address on the street type', () => {
  assert.deepEqual(partsFromGuras('63 KEMBLA STREET WOLLONGONG', '63'), {
    houseNumber: '63',
    street: 'KEMBLA STREET',
    suburb: 'WOLLONGONG',
    state: 'NSW',
    postcode: null,
  });
});

test('partsFromGuras keeps a multi-word suburb whole', () => {
  assert.deepEqual(partsFromGuras('31 KEMBLA STREET PORT KEMBLA', '31'), {
    houseNumber: '31',
    street: 'KEMBLA STREET',
    suburb: 'PORT KEMBLA',
    state: 'NSW',
    postcode: null,
  });
});

test('partsFromGuras handles a unit number', () => {
  assert.deepEqual(partsFromGuras('2/27 KEMBLA STREET BALGOWNIE', '2/27'), {
    houseNumber: '2/27',
    street: 'KEMBLA STREET',
    suburb: 'BALGOWNIE',
    state: 'NSW',
    postcode: null,
  });
});

test('partsFromGuras leaves the street whole when there is no recognised type', () => {
  // Guessing a split here would invent a suburb; better to record less.
  assert.deepEqual(partsFromGuras('12 THE KINGSWAY', '12'), {
    houseNumber: '12',
    street: 'THE KINGSWAY',
    suburb: null,
    state: 'NSW',
    postcode: null,
  });
});
