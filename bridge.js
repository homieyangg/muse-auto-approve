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
    const approvals = approvalsOfFiber(start, walk);
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

  function setAttr(el, name, value) {
    if (!value) el.removeAttribute(name);
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  // Unknown removes all four attributes. Returns whether the node got a verified answer from approval data
  function markItem(el, walk = newWalk()) {
    let marks = null;
    try {
      marks = marksFor(fiberOf(el), walk);
    } catch (err) {
      console.warn('[MAA] bridge read failed', err);
    }
    setAttr(el, 'data-maa-approval-id', marks?.approvalId);
    setAttr(el, 'data-maa-policy', marks?.policy);
    setAttr(el, 'data-maa-site', marks?.site);
    setAttr(el, 'data-maa-purchase', marks?.purchase ? '1' : '');
    return !!marks?.found;
  }

  function markItems() {
    const walk = newWalk();
    for (const el of document.querySelectorAll(ITEM_SELECTOR)) {
      if (!el.matches(CARD_SELECTOR) && !el.closest('section, ' + CARD_SELECTOR)) continue;
      markItem(el, walk);
    }
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
    module.exports = { isPurchaseApproval, marksFor };
    return;
  }

  document.addEventListener(MARK_EVENT, markOnRequest, true);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(update, 2000);
  schedule();
})();
