// My Studies on Clinician Home: does a study's Requesting Physician name the logged-in account (physician-name.js)?
// Synthetic names only.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { matches } = require('../worklist-v0/hpacs-lite/physician-name.js');

const hong = { familyName: '홍', givenName: '길동', fullName: '홍길동', displayName: '홍 길동' };
const lee = { familyName: 'Lee', givenName: 'Soojin', fullName: 'Soojin Lee', displayName: 'Lee Soojin' };

test('a representation with the same family and given name matches, in any of the person name groups', () => {
  assert.equal(matches('Hong^Gil Dong=홍^길동', hong), true);
  assert.equal(matches('홍^길동', hong), true);
  assert.equal(matches('홍길동', hong), true, 'Hangul written together');
  assert.equal(matches('LEE^SOOJIN', lee), true, 'case');
  assert.equal(matches('Lee^Soo-Jin', { ...lee, givenName: 'Soo Jin' }), true, 'spaces and hyphens inside a part');
  assert.equal(matches('Lee^Soojin^^Dr.', lee), true, 'the prefix is ignored');
  assert.equal(matches('Ｌｅｅ^Ｓｏｏｊｉｎ', lee), true, 'compatibility forms');
  assert.equal(matches('Kim^Gil^Dong', { familyName: 'Kim', givenName: 'Gil Dong' }), true, 'the middle name belongs to the given name');
});

test('another physician, a swapped boundary, a suffix or a missing side never match', () => {
  assert.equal(matches('Kim^Lee', { familyName: 'Lee', givenName: 'Kim' }), false, 'swapped family and given');
  assert.equal(matches('Lee^Soojin', { familyName: 'Lee', givenName: 'Minho' }), false);
  assert.equal(matches('Lee^Soojin^^^Jr', lee), false, 'a generation suffix is never assumed');
  assert.equal(matches('이^수진', hong), false);
  assert.equal(matches('', lee), false);
  assert.equal(matches(null, lee), false);
  assert.equal(matches('Lee^Soojin', { familyName: 'Lee' }), false, 'only one part of the account');
  assert.equal(matches('Lee^Soojin', { displayName: 'Lee Soojin' }), false, 'a display name may be a login and is not compared');
  assert.equal(matches('Lee^Soojin', { fullName: 'Soojin Lee' }), false, 'a Latin full name has no known order');
});

test('without name parts only a Hangul full name written together is compared, family first', () => {
  assert.equal(matches('홍^길동', { fullName: '홍길동' }), true);
  assert.equal(matches('Hong^Gildong=홍^길동', { fullName: '홍길동' }), true);
  assert.equal(matches('홍^길동', { fullName: '홍 길동' }), false, 'with a space the order is not known');
  assert.equal(matches('길동^홍', { fullName: '홍길동' }), false);
});
