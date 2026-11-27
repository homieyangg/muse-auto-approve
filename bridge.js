'use strict';

// 跑在 muse 頁面自己的 JS 環境（MAIN world）。content script 在隔離環境讀不到 React 內部資料，
// 這裡把每張審批卡、批次卡每一項、面板預覽列對應的審批 ID 和權限種類，以及全部待審的 ID 寫成 DOM 屬性給它讀
(() => {
  const CARD_SELECTOR = '[data-testid="hatch-inline-approval-card"]';
  const ITEM_SELECTOR = `${CARD_SELECTOR}, [aria-expanded]`;
  const MAX_UP = 12;
  const MAX_FIBERS = 50000;
  // Matched against key names, not a fixed list, so checkout kinds muse adds later are still caught
  const PURCHASE_RE = /checkout|purchase|payment/i;
  const MARK_EVENT = 'maa-mark';
  const MARK_REQUEST_ATTR = 'data-maa-mark-request';
  const MARKED_ATTR = 'data-maa-marked';
  // Only chat-surface cards are read from approval data; the approvals panel and its "more allow options" menu keep main's
  // text rules
  const CHAT_CARD_SELECTOR = `${CARD_SELECTOR}[data-hatch-approval-surface="chat"]`;
  const BACKGROUND_SELECTOR = '[data-hatch-background-approval-surface="true"]';
  const MENU_SELECTOR = '[aria-haspopup="menu"]';
  // The decision key seen on the chat layout's button components a few fibers above each <button>:
  // `<approvalId>-cta-<index>-<kind>`. Searched upward, never at a fixed depth
  const DECISION_KEY_RE = /^(.+)-cta-(\d+)-([a-z_]+)$/;
  const DECISION_KEY_HINT = /-cta-/;
  const KEY_UP = 24;
  const OPTION_ATTRS = { kind: 'data-maa-option-kind', labelKind: 'data-maa-label-kind', scope: 'data-maa-scope' };
  const DATA_PATH_ATTR = 'data-maa-data-path';
  const STATE_ATTR = 'data-maa-state';
  // Which chat or schedule asked, from the approval's scope; written only when every source of the card agrees
  const THREAD_ATTR = 'data-maa-thread-id';
  const SCHEDULE_ATTR = 'data-maa-schedule-id';
  // Sidebar rows: the row's [title] element has the thread id in actionAnalyticsMetadata a few dozen fibers up (23 seen live),
  // with a key holding the same id just above it
  const THREAD_ROW_SELECTOR = '[data-testid="hatch-thread-row"]';
  const ROW_UP = 40;
  const ROW_KEY_UP = 3;
  let timer = null;
  let queryClient = null;

  function fiberOf(el) {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    return key ? el[key] : null;
  }

  function isApproval(v) {
    return !!v && typeof v === 'object' && typeof v.approvalId === 'string';
  }

  // 批次卡每一項和預覽列是單筆，整張卡是陣列
  function approvalsInProps(fiber) {
    const props = fiber?.memoizedProps;
    if (!props || typeof props !== 'object') return null;
    for (const v of Object.values(props)) {
      if (isApproval(v)) return [v];
      if (Array.isArray(v) && v.length && v.every(isApproval)) return v;
    }
    return null;
  }

  const newWalk = () => ({ memo: new Map(), steps: 0 });

  // The DOM node may point at the fiber from the previous render. A fiber is current when it is the current root, or
  // when it (or its alternate) sits among the children of its parent's current version, as React's findCurrentFiberUsingSlowPath
  // does. Returns null when that can't be established (broken tree or step cap reached)
  function currentOf(fiber, walk) {
    if (!fiber) return null;
    if (walk.memo.has(fiber)) return walk.memo.get(fiber);
    let found = null;
    if (!fiber.return) {
      const root = fiber.stateNode?.current;
      if (root && (root === fiber || root === fiber.alternate)) found = root;
    } else {
      const parent = currentOf(fiber.return, walk);
      for (let c = parent?.child; c; c = c.sibling) {
        if (++walk.steps > MAX_FIBERS) break;
        if (c === fiber || c === fiber.alternate) { found = c; break; }
      }
    }
    walk.memo.set(fiber, found);
    return found;
  }

  // 往上找第一個 props 帶審批資料的元件，只讀確認是 current 的 fiber；null means the current tree could not be established
  function approvalsOfFiber(start, walk = newWalk()) {
    let f = currentOf(start, walk);
    if (!f) return null;
    for (let i = 0; i < MAX_UP; i++) {
      const approvals = approvalsInProps(f);
      if (approvals) return approvals;
      if (!f.return) return [];
      f = currentOf(f.return, walk);
      if (!f) return null;
    }
    return [];
  }

  // Every data-maa-* value for a node comes from this one walk; null means unknown
  function marksFor(start, walk) {
    return marksOf(approvalsOfFiber(start, walk));
  }

  function marksOf(approvals) {
    if (!approvals) return null;
    const one = approvals.length === 1 ? approvals[0] : null;
    return {
      approvalId: one?.approvalId || '',
      policy: one?.policySubject || '',
      site: one ? destinationOf(one) : '',
      purchase: approvals.some(isPurchaseApproval),
      found: approvals.length > 0,
    };
  }

  // Upload approvals carry the target in payloadPreview, e.g. "Destination: https://tmpfiles.org"
  function destinationOf(approval) {
    const m = String(approval.payloadPreview ?? '').match(/^Destination:\s*(\S+)/m);
    if (!m) return '';
    try { return new URL(m[1]).hostname; } catch { return ''; }
  }

  function hasValue(v) {
    return v !== null && v !== undefined && v !== false && v !== '' && !(Array.isArray(v) && !v.length);
  }

  // Decided from muse's structured approval data so it works whatever language the card title is in
  function isPurchaseApproval(approval) {
    if (!approval || typeof approval !== 'object') return false;
    if (Object.keys(approval).some(k => PURCHASE_RE.test(k) && hasValue(approval[k]))) return true;
    const p = approval.serverPresentation;
    if (!p || typeof p !== 'object') return false;
    return PURCHASE_RE.test(String(p.payloadType ?? '')) || p.paymentProvider != null || p.purchasePreapproval != null;
  }

  // undefined: the fiber is not current; null: no cta key below the approval component within KEY_UP fibers
  function decisionKeyOf(start, walk) {
    let f = currentOf(start, walk);
    if (!f) return undefined;
    for (let i = 0; i < KEY_UP; i++) {
      if (typeof f.key === 'string' && DECISION_KEY_HINT.test(f.key)) return f.key;
      if (approvalsInProps(f) || !f.return) return null;
      f = currentOf(f.return, walk);
      if (!f) return undefined;
    }
    return null;
  }

  // A value that is not a string (an object scope, say) is unknown, never "no scope": it must not pass the whitelist as empty
  const optionText = v => (v == null || v === '' ? '' : typeof v === 'string' ? v : '?');
  const markOf = option => ({ kind: optionText(option.kind), labelKind: optionText(option.label?.kind), scope: optionText(option.label?.scope) });

  // The mark of decisionOptions[i] in one approval's data for a parsed cta key, or null when the kind does not match
  function keyMark(approval, m) {
    const options = approval?.serverPresentation?.decisionOptions;
    const option = Array.isArray(options) ? options[Number(m[2])] : null;
    return option && typeof option.kind === 'string' && option.kind === m[3] ? markOf(option) : null;
  }

  const sameMarks = marks => marks.every(mark => JSON.stringify(mark) === JSON.stringify(marks[0]));

  // { threadId, scheduleId } of one approval, '' when absent; null when a value is not a string or the scope and the top
  // level name different schedules
  function sourceIdsOf(approval) {
    const scope = approval?.scope && typeof approval.scope === 'object' ? approval.scope : {};
    const text = v => (v == null || v === '' ? '' : typeof v === 'string' ? v : null);
    const threadId = text(scope.threadId), scoped = text(scope.scheduleId), top = text(approval?.scheduleId);
    if (threadId === null || scoped === null || top === null || (scoped && top && scoped !== top)) return null;
    return { threadId, scheduleId: scoped || top };
  }

  // The ids every source gives, or null when any source differs, can't be read, or none has an id. Never picks one
  function agreedSource(approvals) {
    const ids = approvals.map(sourceIdsOf);
    if (!ids.length || ids.some(i => !i) || !sameMarks(ids)) return null;
    return ids[0].threadId || ids[0].scheduleId ? ids[0] : null;
  }

  // A source with no decisionOptions field has no data and is skipped; [] or different options is a veto
  const hasData = approval => Array.isArray(approval?.serverPresentation?.decisionOptions);

  // Reads one approval's buttons in a single pass into { state, missing, marks }. Sources are the card's approval, every
  // button's nearest approval and the pending list's entry for the same id; only the ones with data count, and every button
  // is checked against all of them, so a veto from any source ([] or a different option) applies to the whole card.
  // '': no source has data, or every button reads without a cta key (not the chat layout): main's text rules. 'clean': card-side
  // data exists (the card's or a button's own approval), at least one button is keyed, and every keyed button carries this
  // approval's key and maps to the same option in every source. 'anomalous': anything else; nothing later in the pass
  // resets it. Every keyed button the sources agree on is marked; keyless buttons never are. content.js clicks only a
  // confirmed once on an anomalous card
  function optionMarks(approval, buttons, walk = newWalk(), pendingById = () => null) {
    const id = approval?.approvalId;
    const none = { state: '', missing: true, marks: buttons.map(() => null), source: null };
    const reads = buttons.map(({ fiber }) => {
      const key = decisionKeyOf(fiber, walk);
      return { key, own: key === undefined ? null : approvalsOfFiber(fiber, walk) };
    });
    if (reads.every(r => r.key === null)) return none;
    const cached = pendingById(id);
    const cardSide = [...new Set([approval, ...reads.flatMap(r => r.own || [])])].filter(a => a?.approvalId === id && hasData(a));
    const sources = [...cardSide, ...(hasData(cached) ? [cached] : [])];
    if (!sources.length) return none;
    let anomalous = !cardSide.length, keyed = 0;
    const marks = reads.map(({ key, own }) => {
      const m = typeof key === 'string' ? key.match(DECISION_KEY_RE) : null;
      if (!own || own.some(a => a.approvalId !== id) || (m && m[1] !== id)) {
        anomalous = true;
        return null;
      }
      if (key === null) return null;
      const found = m && own.length === 1 ? sources.map(a => keyMark(a, m)) : [null];
      if (!found[0] || !sameMarks(found)) {
        anomalous = true;
        return null;
      }
      keyed++;
      return found[0];
    });
    if (!keyed) anomalous = true;
    // The same sources, whether or not they carry options; a button read that failed or reached another approval makes the ids unknown
    const readFailed = reads.some(r => !r.own || r.own.some(a => a.approvalId !== id));
    const all = [...new Set([approval, ...reads.flatMap(r => r.own || []), ...(cached ? [cached] : [])])];
    const source = readFailed ? null : agreedSource(all);
    return { state: anomalous ? 'anomalous' : 'clean', missing: anomalous, marks, source };
  }

  function setAttr(el, name, value) {
    if (!value) el.removeAttribute(name);
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function writeOption(button, mark) {
    for (const [field, name] of Object.entries(OPTION_ATTRS)) setAttr(button, name, mark?.[field]);
  }

  function onChatCard(el) {
    return !!el.closest(CHAT_CARD_SELECTOR) && !el.closest(BACKGROUND_SELECTOR);
  }

  // Marks the decision buttons of a chat-surface card or combined-card item from the same walk as the item itself. Other
  // surfaces get no state, and a combined card holding several approvals leaves its buttons to its items
  function markOptions(el, approvals, walk, pendingById) {
    const buttons = [...el.querySelectorAll('button')].filter(b => !b.matches(MENU_SELECTOR));
    let result;
    if (!onChatCard(el)) {
      result = { state: '', missing: false, marks: buttons.map(() => null) };
    } else if (approvals?.length > 1) {
      result = { state: '', missing: approvals.some(a => !hasData(a)), marks: null };
    } else if (approvals?.length === 1) {
      result = optionMarks(approvals[0], buttons.map(b => ({ fiber: fiberOf(b) })), walk, pendingById);
    } else {
      // [] is a card without approval data; null is a non-current walk, unless the node has no React fiber at all
      result = { state: '', missing: !!approvals || !fiberOf(el), marks: buttons.map(() => null) };
    }
    if (result.marks) buttons.forEach((b, i) => writeOption(b, result.marks[i]));
    setAttr(el, STATE_ATTR, result.state);
    setAttr(el, DATA_PATH_ATTR, result.missing ? 'missing' : '');
    writeSource(el, result.state ? result.source : null);
  }

  function writeSource(el, source) {
    setAttr(el, THREAD_ATTR, source?.threadId);
    setAttr(el, SCHEDULE_ATTR, source?.scheduleId);
  }

  // Unknown removes every attribute. Returns whether the node got a verified answer from approval data
  function markItem(el, walk = newWalk(), pendingById = pendingLookup()) {
    let approvals = null, marks = null;
    try {
      approvals = approvalsOfFiber(fiberOf(el), walk);
      marks = marksOf(approvals);
    } catch (err) {
      approvals = null;
      console.warn('[MAA] bridge read failed', err);
    }
    setAttr(el, 'data-maa-approval-id', marks?.approvalId);
    setAttr(el, 'data-maa-policy', marks?.policy);
    setAttr(el, 'data-maa-site', marks?.site);
    setAttr(el, 'data-maa-purchase', marks?.purchase ? '1' : '');
    try {
      markOptions(el, approvals, walk, pendingById);
    } catch (err) {
      console.warn('[MAA] bridge option read failed', err);
      // A failed read may have hidden data, so a chat card must not fall back to main's text rules
      for (const b of el.querySelectorAll('button')) writeOption(b, null);
      writeSource(el, null);
      const chat = onChatCard(el);
      setAttr(el, STATE_ATTR, chat ? 'anomalous' : '');
      setAttr(el, DATA_PATH_ATTR, chat ? 'missing' : '');
    }
    return !!marks?.found;
  }

  function markItems() {
    const walk = newWalk();
    const pendingById = pendingLookup();
    for (const el of document.querySelectorAll(ITEM_SELECTOR)) {
      if (!el.matches(CARD_SELECTOR) && !el.closest('section, ' + CARD_SELECTOR)) continue;
      markItem(el, walk, pendingById);
    }
  }

  // Thread id of a sidebar row, or '' when the metadata or the matching key isn't found within the bound
  function threadIdOfRow(row, walk) {
    const title = row.querySelector('[title]');
    let f = title ? currentOf(fiberOf(title), walk) : null;
    for (let i = 0; f && i < ROW_UP; i++) {
      const id = f.memoizedProps?.actionAnalyticsMetadata?.thread_id;
      if (typeof id === 'string' && id) {
        let k = f.return ? currentOf(f.return, walk) : null;
        for (let j = 0; k && j < ROW_KEY_UP; j++) {
          if (typeof k.key === 'string' && k.key.includes(id)) return id;
          k = k.return ? currentOf(k.return, walk) : null;
        }
        return '';
      }
      f = f.return ? currentOf(f.return, walk) : null;
    }
    return '';
  }

  // Lets the extension name a chat it only knows by id, in its UI and in new rules; cards are never matched against it
  function markThreadRows(walk = newWalk()) {
    for (const row of document.querySelectorAll(THREAD_ROW_SELECTOR)) {
      let id = '';
      try { id = threadIdOfRow(row, walk); } catch { id = ''; }
      setAttr(row, THREAD_ATTR, id);
    }
  }

  function pendingLookup() {
    const pending = findPending() || [];
    return id => pending.find(a => isApproval(a) && a.approvalId === id && !a.decidedAtMs) || null;
  }

  // content.js asks for a fresh mark right before it clicks. Listeners run inside its dispatchEvent, so the answer is
  // there when dispatchEvent returns; echoing its token proves this run read approval data for this node
  function markOnRequest(e) {
    const el = e.target;
    if (!(el instanceof Element)) return;
    el.removeAttribute(MARKED_ATTR);
    try {
      if (markItem(el)) el.setAttribute(MARKED_ATTR, el.getAttribute(MARK_REQUEST_ATTR) || '');
    } catch (err) {
      console.warn('[MAA] bridge mark failed', err);
    }
  }

  // muse 用 react-query，從最上層的 Provider 拿到 QueryClient，物件不會換，找到一次就好
  function findQueryClient() {
    const start = fiberOf(document.querySelector('[data-testid]') || document.body);
    if (!start) return null;
    let root = start;
    while (root.return) root = root.return;
    const stack = [root];
    for (let n = 0; stack.length && n < MAX_FIBERS; n++) {
      const f = stack.pop();
      const value = f.memoizedProps?.value;
      if (typeof value?.getQueryCache === 'function') return value;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  }

  // 全部待審（包含別的聊天室、排程）在審批查詢的 data.pending，用來判斷有沒有畫面上看不到的審批
  function findPending() {
    queryClient = queryClient || findQueryClient();
    const query = queryClient?.getQueryCache().getAll().find(q => Array.isArray(q.state?.data?.pending) && Array.isArray(q.state.data.recent));
    return query ? query.state.data.pending : null;
  }

  function markPending() {
    const pending = findPending();
    const ids = pending ? pending.filter(a => isApproval(a) && !a.decidedAtMs).map(a => a.approvalId).join(' ') : '';
    if (pending) document.documentElement.setAttribute('data-maa-pending', ids);
    else document.documentElement.removeAttribute('data-maa-pending');
  }

  function update() {
    timer = null;
    try {
      markItems();
      markPending();
      markThreadRows();
    } catch (e) {
      console.warn('[MAA] bridge failed', e);
    }
  }

  // content script 在 DOM 變動 300ms 後才掃，這裡 50ms 內先把屬性標好
  function schedule() {
    if (!timer) timer = setTimeout(update, 50);
  }

  // Loaded from node tests: export the predicate without touching the DOM
  if (typeof window === 'undefined') {
    module.exports = { isPurchaseApproval, marksFor, optionMarks, markItem, threadIdOfRow };
    return;
  }

  document.addEventListener(MARK_EVENT, markOnRequest, true);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(update, 2000);
  schedule();
})();
