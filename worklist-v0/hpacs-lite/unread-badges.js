/**
 * In-app unread marks (Clinician Home and the reading screen). Inside HALO only: no email, message, browser notification
 * or sound.
 *
 * The rule is the server's (GET unread, api/src/clinician-question.service.ts and image-request.service.ts unread()): an
 * item is unread for this person while it holds an entry by someone else of the kinds their view waits for above the
 * revision their own seen mark records. This module only reads that answer and reports what the screen showed:
 *   - refresh() reads every page of each view the screen asked for; a later answer replaces an earlier one, an answer
 *     that started before a newer refresh is dropped, a failed read keeps what was last known (never a made-up 0), and a
 *     403 (the view's role taken away) clears that view;
 *   - shown(view, id, revision) is called when the screen has drawn that thread or request at that revision in a pane the
 *     person has open. While it stays drawn (until hidden(view, id)), and the item is unread, the seen mark is sent once
 *     for that revision - whether the drawing or the count arrived first. Nothing is sent while the page is hidden, the
 *     screen says it may not (offline, locked, ended) or the drawn revision is already sent;
 *   - a seen write counts only as a 201 naming this account, this item and a stored revision; then the counts are read
 *     again from the server. A failed write changes nothing on the screen (the mark stays; the next drawing sends again).
 * An answer naming another account calls onAccount() and the module stops.
 */
(function (root) {
  'use strict';
  const VIEWS = {
    'question-inbox': { seen: id => `/questions/${encodeURIComponent(id)}/seen` },
    'question-mine': { seen: id => `/questions/${encodeURIComponent(id)}/seen` },
    'image-request-mine': { seen: id => `/image-requests/${encodeURIComponent(id)}/seen` },
  };
  const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
  const PAGES = 50;

  function mount({ send, views, owner, allowed = () => true, onChange = () => {}, onAccount = () => {}, pollMs = 0 }) {
    const wanted = views.filter(view => Object.prototype.hasOwnProperty.call(VIEWS, view));
    // Per view: null = not known yet; { available, count, items: Map(id -> { studyUid, revision, openUid }) } once read.
    const state = new Map(wanted.map(view => [view, null]));
    const failed = new Set();
    // What the screen has drawn now: view -> Map(id -> revision). sent: view -> Map(id -> revision already sent).
    const drawn = new Map(wanted.map(view => [view, new Map()]));
    const sent = new Map(wanted.map(view => [view, new Map()]));
    let seq = 0, ended = false, timer = null;

    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const ownerOf = data => {
      const value = data && data.owner, mine = owner();
      if (!Array.isArray(value) || value.length !== 2 || !value.every(part => typeof part === 'string')) return null;
      return !!mine && value[0] === mine[0] && value[1] === mine[1];
    };
    const stop = () => {
      ended = true;
      seq++;
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const account = () => {
      if (ended) return;
      stop();
      for (const view of wanted) state.set(view, null);
      onChange();
      onAccount();
    };

    /** One view, every page. Throws on a failed or malformed page; returns null when another account answered. */
    async function readView(view) {
      const items = new Map();
      let cursor = null, count = null, available = null;
      for (let page = 0; page < PAGES; page++) {
        const answer = await send('GET', `/unread?view=${encodeURIComponent(view)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        const data = answer && answer.body;
        const same = ownerOf(data);
        if (same === false) return null;
        if (same === null || data.view !== view || typeof data.available !== 'boolean' || !Number.isSafeInteger(data.count)
            || data.count < 0 || !Array.isArray(data.items) || data.items.length > 100
            || !(data.nextCursor === null || (typeof data.nextCursor === 'string' && CURSOR.test(data.nextCursor) && data.nextCursor !== cursor)))
          throw new Error('malformed');
        if (available !== null && (available !== data.available)) throw new Error('changed');
        available = data.available;
        count = data.count;
        for (const item of data.items) {
          if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ID.test(item.id) || typeof item.studyUid !== 'string'
              || !item.studyUid || !Number.isSafeInteger(item.revision) || item.revision < 1
              || !(item.openUid === null || (typeof item.openUid === 'string' && item.openUid))) throw new Error('malformed');
          // openUid: the listed row the server answers this item's study on now (null: none for this person). A screen
          // marks and opens that row only.
          items.set(item.id, { studyUid: item.studyUid, revision: item.revision, openUid: item.openUid });
        }
        cursor = data.nextCursor;
        if (cursor === null) break;
      }
      return { available, count: available ? count : 0, items: available ? items : new Map() };
    }

    async function refresh() {
      if (ended || !allowed()) return;
      const mine = ++seq;
      const read = await Promise.all(wanted.map(view => readView(view).then(value => ({ view, value }), error => ({ view, error }))));
      if (ended || mine !== seq) return;
      if (read.some(entry => entry.value === null && !entry.error)) { account(); return; }
      for (const entry of read) {
        // The server refused this view (a role taken away): what it showed goes, it is not kept as the last known count.
        if (entry.error && entry.error.status === 403) {
          failed.delete(entry.view);
          state.set(entry.view, { available: false, count: 0, items: new Map() });
          continue;
        }
        if (entry.error) { failed.add(entry.view); continue; }
        failed.delete(entry.view);
        state.set(entry.view, entry.value);
      }
      onChange();
      for (const view of wanted) for (const [id, revision] of drawn.get(view)) mark(view, id, revision);
    }

    async function mark(view, id, revision) {
      const known = state.get(view);
      if (ended || !known || !known.items.has(id) || !allowed() || !visible()) return;
      if ((sent.get(view).get(id) || 0) >= revision) return;
      sent.get(view).set(id, revision);
      let answer;
      try {
        answer = await send('POST', VIEWS[view].seen(id), { expectedOwner: owner(), revision });
      } catch (_) {
        // Not stored as far as this screen knows: the mark stays and the next drawing sends again.
        if (sent.get(view).get(id) === revision) sent.get(view).delete(id);
        return;
      }
      if (ended) return;
      const data = answer && answer.body, same = ownerOf(data);
      if (same === false) { account(); return; }
      const seen = data && data.seen;
      if (answer.status !== 201 || same !== true || !seen || seen.id !== id || !Number.isSafeInteger(seen.revision) || seen.revision < 1) {
        if (sent.get(view).get(id) === revision) sent.get(view).delete(id);
        return;
      }
      await refresh();
    }

    if (pollMs > 0) timer = setInterval(() => { if (visible()) refresh(); }, pollMs);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
      if (ended || !visible()) return;
      refresh();
    });

    return {
      refresh,
      /** The screen drew this item at this revision in an open pane. */
      shown(view, id, revision) {
        if (ended || !drawn.has(view) || typeof id !== 'string' || !Number.isSafeInteger(revision) || revision < 1) return;
        drawn.get(view).set(id, revision);
        mark(view, id, revision);
      },
      /** The screen no longer shows it (pane closed, another thread, another study). */
      hidden(view, id) {
        if (!drawn.has(view)) return;
        if (id === undefined) drawn.get(view).clear(); else drawn.get(view).delete(id);
      },
      /** The view as last read: null while unknown; failed = the last read did not answer (the values are the earlier ones). */
      view(view) {
        const known = state.get(view);
        return known ? { available: known.available, count: known.count, items: known.items, failed: failed.has(view) } : null;
      },
      unread(view, id) { const known = state.get(view); return !!known && known.items.has(id); },
      end() {
        if (ended) return;
        stop();
        for (const view of wanted) { state.set(view, null); drawn.get(view).clear(); sent.get(view).clear(); }
        onChange();
      },
    };
  }

  root.KinUnread = Object.freeze({ mount });
})(window);
