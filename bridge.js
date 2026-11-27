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
  const BACKGROUND_SELECTOR = '[data-hatch-background-approval-surface="true"]';
  const MENU_SELECTOR = '[aria-haspopup="menu"]';
  const PRIMARY_SELECTOR = '[data-hatch-approval-primary-action="true"]';
  const MENU_ITEM_SELECTOR = '[role="menuitem"]';
  // Decision keys seen on muse's components a few fibers above the element: `<approvalId>-cta-<index>-<kind>` in the chat
  // layout, `-compact-deny-` / `-compact-allow-` in the approvals panel. Searched upward, never at a fixed depth
  const DECISION_KEY_RE = /^(.+)-(cta|compact-deny|compact-allow)-(\d+)-([a-z_]+)$/;
  const DECISION_KEY_HINT = /-(?:cta|compact-deny|compact-allow)-/;
  const KEY_UP = 24;
  const OPTION_ATTRS = { kind: 'data-maa-option-kind', labelKind: 'data-maa-label-kind', scope: 'data-maa-scope' };
  const OPTION_APPROVAL_ATTR = 'data-maa-option-approval';
  const OPTIONS_ATTR = 'data-maa-options';
  const DATA_PATH_ATTR = 'data-maa-data-path';
  const STATE_ATTR = 'data-maa-state';
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
  function approvalsOfFiber(start, walk = newWalk(), maxUp = MAX_UP) {
    let f = currentOf(start, walk);
    if (!f) return null;
    for (let i = 0; i < maxUp; i++) {
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

  // undefined: the fiber is not current; null: no decision key below the approval component within KEY_UP fibers
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
  const isAllowKind = kind => typeof kind === 'string' && kind.startsWith('allow');
  const isDenyKind = kind => typeof kind === 'string' && kind.startsWith('deny');
  const markOf = option => ({ kind: optionText(option.kind), labelKind: optionText(option.label?.kind), scope: optionText(option.label?.scope) });

  // The option a decision key points at, or null. cta indexes decisionOptions; compact-deny indexes the deny options and
  // compact-allow the allow options after the primary one. Compact keys carry only the kind, so when that kind appears more
  // than once with different labels or scopes the key can't tell them apart and nothing is returned
  function optionForKey(options, form, index, kind) {
    let group = options;
    if (form === 'compact-deny') group = options.filter(o => isDenyKind(o?.kind));
    else if (form === 'compact-allow') group = options.filter(o => isAllowKind(o?.kind)).slice(1);
    const option = group[index];
    if (!option || typeof option.kind !== 'string' || option.kind !== kind) return null;
    if (form === 'cta') return option;
    const same = group.filter(o => o.kind === kind).map(o => JSON.stringify(markOf(o)));
    return new Set(same).size === 1 ? option : null;
  }

  // The panel's primary button has no key: it is allow once only when that is the first allow option in the data
  function primaryOption(options) {
    const first = options.find(o => isAllowKind(o?.kind));
    return first?.kind === 'allow_once' ? first : null;
  }

  // The mark of the option a parsed decision key points at in one approval's data, or null
  function keyMark(approval, m) {
    const options = approval?.serverPresentation?.decisionOptions;
    const option = Array.isArray(options) ? optionForKey(options, m[2], Number(m[3]), m[4]) : null;
    return option ? markOf(option) : null;
  }

  function primaryMark(approval) {
    const options = approval?.serverPresentation?.decisionOptions;
    const option = Array.isArray(options) ? primaryOption(options) : null;
    return option ? markOf(option) : null;
  }

  const sameMarks = marks => marks.every(mark => JSON.stringify(mark) === JSON.stringify(marks[0]));

  // Reads one approval's buttons in a single pass into { state, missing, options, marks }. state 'clean': at least one keyed
  // button, and every keyed button carries this approval's key and maps to the same option in every source holding the
  // approval (the card's, the button's nearest one, the pending list's). 'anomalous': the options were read but a button is
  // keyed to or sits under another approval, a key does not map, the sources disagree, a fiber can't be confirmed, or no
  // button is keyed; nothing later in the pass resets it. '': no decisionOptions, main's text rules.
  // Every button confirmed on its own is marked; content.js clicks only a confirmed once button on an anomalous card.
  // A keyless primary is marked allow once only when it is the first allow option and a keyed button of this approval exists
  function optionMarks(approval, buttons, walk = newWalk(), pendingById = () => null) {
    const options = approval?.serverPresentation?.decisionOptions;
    if (!Array.isArray(options)) return { state: '', missing: true, options: null, marks: buttons.map(() => null) };
    const cached = pendingById(approval.approvalId);
    let anomalous = false, keyed = 0;
    const found = buttons.map(({ fiber, primary }) => {
      const key = decisionKeyOf(fiber, walk);
      const own = key === undefined ? null : approvalsOfFiber(fiber, walk);
      const m = typeof key === 'string' ? key.match(DECISION_KEY_RE) : null;
      if (!own || own.some(a => a.approvalId !== approval.approvalId) || (m && m[1] !== approval.approvalId)) {
        anomalous = true;
        return null;
      }
      const sources = [approval, ...own, ...(cached ? [cached] : [])];
      if (key === null) return primary && own.length === 1 ? { sources } : null;
      const marks = m && own.length === 1 ? sources.map(a => keyMark(a, m)) : [null];
      if (!marks[0] || !sameMarks(marks)) {
        anomalous = true;
        return null;
      }
      keyed++;
      return marks[0];
    });
    if (!keyed && buttons.length) anomalous = true;
    const marks = found.map(f => {
      if (!f?.sources) return f;
      const all = f.sources.map(primaryMark);
      if (!sameMarks(all)) anomalous = true;
      return keyed && sameMarks(all) ? all[0] : null;
    });
    return { state: anomalous ? 'anomalous' : 'clean', missing: anomalous, options: options.map(o => markOf(o || {})), marks };
  }

  // A "more allow options" item is drawn in a portal, so its approval is looked up by the key's id in the pending list.
  // The same key must point at the same option in the pending list, in the cards showing that approval (cardsById) and in
  // the portal's own approval ancestor if it has one; at least one card side must be reached. Any difference (one source
  // may say broad) leaves the item unmarked. Returns { approvalId, kind, labelKind, scope }, or null
  function menuItemMark(start, walk = newWalk(), pendingById = () => null, cardsById = () => []) {
    const key = decisionKeyOf(start, walk);
    const m = typeof key === 'string' ? key.match(DECISION_KEY_RE) : null;
    if (!m || m[2] !== 'compact-allow') return null;
    const own = approvalsOfFiber(start, walk, KEY_UP + MAX_UP);
    if (!own || own.length > 1 || (own.length === 1 && own[0].approvalId !== m[1])) return null;
    const cards = [...own, ...cardsById(m[1], walk)];
    const pending = pendingById(m[1]);
    if (!pending || !cards.length) return null;
    const marks = [pending, ...cards].map(a => keyMark(a, m));
    if (!marks[0] || !sameMarks(marks)) return null;
    return { approvalId: m[1], ...marks[0] };
  }

  function setAttr(el, name, value) {
    if (!value) el.removeAttribute(name);
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function writeOption(button, mark) {
    for (const [field, name] of Object.entries(OPTION_ATTRS)) setAttr(button, name, mark?.[field]);
  }

  // Marks the decision buttons of a card or combined-card item from the same walk as the item itself. A combined card
  // holds several approvals and leaves its buttons to its items
  function markOptions(el, approvals, walk, pendingById) {
    if (!el.closest(CARD_SELECTOR) || el.closest(BACKGROUND_SELECTOR)) return;
    const buttons = [...el.querySelectorAll('button')].filter(b => !b.matches(MENU_SELECTOR));
    let result;
    if (approvals?.length > 1) {
      const missing = approvals.some(a => !Array.isArray(a.serverPresentation?.decisionOptions));
      result = { state: '', missing, options: null, marks: null };
    } else if (approvals?.length === 1) {
      result = optionMarks(approvals[0], buttons.map(b => ({ fiber: fiberOf(b), primary: b.matches(PRIMARY_SELECTOR) })), walk, pendingById);
    } else {
      // [] is a card without approval data; null is a non-current walk, unless the node has no React fiber at all
      result = { state: '', missing: !!approvals || !fiberOf(el), options: null, marks: buttons.map(() => null) };
    }
    if (result.marks) buttons.forEach((b, i) => writeOption(b, result.marks[i]));
    setAttr(el, STATE_ATTR, result.state);
    setAttr(el, OPTIONS_ATTR, result.options ? JSON.stringify(result.options) : '');
    setAttr(el, DATA_PATH_ATTR, result.missing ? 'missing' : '');
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
      for (const b of el.querySelectorAll('button')) writeOption(b, null);
      el.removeAttribute(OPTIONS_ATTR);
      el.removeAttribute(STATE_ATTR);
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

  function pendingLookup() {
    const pending = findPending() || [];
    return id => pending.find(a => isApproval(a) && a.approvalId === id && !a.decidedAtMs) || null;
  }

  // The approvals read now from the card nodes marked with this id; a node whose fresh walk holds anything else is skipped
  function cardApprovals(id, walk) {
    return [...document.querySelectorAll(ITEM_SELECTOR)]
      .filter(el => el.getAttribute('data-maa-approval-id') === id)
      .map(el => approvalsOfFiber(fiberOf(el), walk))
      .filter(a => a?.length === 1 && a[0].approvalId === id)
      .map(a => a[0]);
  }

  function markMenuItem(el) {
    let mark = null;
    try {
      mark = menuItemMark(fiberOf(el), newWalk(), pendingLookup(), cardApprovals);
    } catch (err) {
      console.warn('[MAA] bridge menu read failed', err);
    }
    writeOption(el, mark);
    setAttr(el, OPTION_APPROVAL_ATTR, mark?.approvalId);
    return !!mark;
  }

  // content.js asks for a fresh mark right before it clicks. Listeners run inside its dispatchEvent, so the answer is
  // there when dispatchEvent returns; echoing its token proves this run read approval data for this node
  function markOnRequest(e) {
    const el = e.target;
    if (!(el instanceof Element)) return;
    el.removeAttribute(MARKED_ATTR);
    try {
      const marked = el.matches(MENU_ITEM_SELECTOR) ? markMenuItem(el) : markItem(el);
      if (marked) el.setAttribute(MARKED_ATTR, el.getAttribute(MARK_REQUEST_ATTR) || '');
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
    module.exports = { isPurchaseApproval, marksFor, optionMarks, menuItemMark };
    return;
  }

  document.addEventListener(MARK_EVENT, markOnRequest, true);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(update, 2000);
  schedule();
})();
