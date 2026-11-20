/*
 * Is the physician a study names the logged-in account? One rule for Clinician Home's My Studies folder.
 *
 * The study side is the server's Requesting Physician (DICOM 0032,1032) as the list row carries it: a DICOM person name,
 * its representations joined by '=' (Alphabetic=Ideographic=Phonetic), each of them family^given^middle^prefix^suffix.
 * The account side is the identity provider's family and given names (GET /me familyName, givenName), or, when it has
 * neither, its full name (fullName) - only a Hangul name written without spaces, read in Korean order (family first).
 * A display name that may be a login is never compared.
 *
 * A representation matches when its family name equals the account's family name and its given name (with the middle
 * name) equals the account's given name, each compared after Unicode compatibility folding, lower case and dropping
 * spaces, dots, hyphens, commas and apostrophes. The boundary between the two is kept: Lee^Kim is not Kim Lee. Hangul
 * names are also compared written together (홍^길동 and 홍길동). The prefix (Dr.) is ignored; a representation with a
 * suffix (Jr., III) never matches - the account cannot say which generation it is. Anything missing is not a match.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinPhysicianName = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const HANGUL_ONLY = /^[ᄀ-ᇿ㄰-㆏가-힣]+$/;
  const TITLE = /^(?:dr|prof|md|m\.d)\.?$/i;
  const fold = value => typeof value === 'string'
    ? value.normalize('NFKC').split(/\s+/).filter(token => token && !TITLE.test(token)).join(' ')
      .toLowerCase().replace(/[\s.\-,'’]/g, '') : '';

  /** The representations of a DICOM person name that can be compared: [{ family, given }] (folded), suffixes left out. */
  function representations(pn) {
    if (typeof pn !== 'string' || !pn.trim()) return [];
    return pn.split('=').flatMap(group => {
      const parts = group.split('^');
      if (fold(parts[4])) return [];
      const family = fold(parts[0]), given = fold([parts[1], parts[2]].filter(Boolean).join(' '));
      return family || given ? [{ family, given }] : [];
    });
  }

  /** The account's names as GET /me gives them, folded; null when nothing comparable is there. */
  function account(me) {
    const family = fold(me && me.familyName), given = fold(me && me.givenName);
    if (family && given) return { family, given };
    if (family || given) return null;
    const full = typeof (me && me.fullName) === 'string' ? me.fullName.normalize('NFKC').trim() : '';
    return HANGUL_ONLY.test(full) ? { joined: full } : null;
  }

  function matches(pn, me) {
    const who = account(me);
    if (!who) return false;
    return representations(pn).some(name => {
      if (who.joined) return HANGUL_ONLY.test(name.family + name.given) && name.family + name.given === who.joined;
      if (name.family && name.given && name.family === who.family && name.given === who.given) return true;
      const together = name.family + name.given, mine = who.family + who.given;
      return HANGUL_ONLY.test(together) && HANGUL_ONLY.test(mine) && together === mine;
    });
  }

  return { matches, representations, account };
});
