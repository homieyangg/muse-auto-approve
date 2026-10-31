'use strict';

// 跑在 muse 頁面自己的 JS 環境（MAIN world）。content script 在隔離環境讀不到 React 內部資料，
// 這裡把每張審批卡、批次卡每一項、面板預覽列對應的審批 ID 和權限種類，以及全部待審的 ID 寫成 DOM 屬性給它讀
(() => {
  const CARD_SELECTOR = '[data-testid="hatch-inline-approval-card"]';
  const ITEM_SELECTOR = `${CARD_SELECTOR}, [aria-expanded]`;
  const MAX_UP = 12;
  const MAX_FIBERS = 50000;
  let timer = null;
  let queryClient = null;

  function fiberOf(el) {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    return key ? el[key] : null;
  }

  function isApproval(v) {
    return !!v && typeof v === 'object' && typeof v.approvalId === 'string';
  }

  // 往上找第一個 props 帶審批資料的元件：批次卡每一項和預覽列是單筆，整張卡是陣列
  function approvalsOf(el) {
    for (let f = fiberOf(el), i = 0; f && i < MAX_UP; f = f.return, i++) {
      const props = f.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      for (const v of Object.values(props)) {
        if (isApproval(v)) return [v];
        if (Array.isArray(v) && v.length && v.every(isApproval)) return v;
      }
    }
    return [];
  }

  // Upload approvals carry the target in payloadPreview, e.g. "Destination: https://tmpfiles.org"
  function destinationOf(approval) {
    const m = String(approval.payloadPreview ?? '').match(/^Destination:\s*(\S+)/m);
    if (!m) return '';
    try { return new URL(m[1]).hostname; } catch { return ''; }
  }

  function setAttr(el, name, value) {
    if (!value) el.removeAttribute(name);
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function markItems() {
    for (const el of document.querySelectorAll(ITEM_SELECTOR)) {
      if (!el.matches(CARD_SELECTOR) && !el.closest('section, ' + CARD_SELECTOR)) continue;
      const approvals = approvalsOf(el);
      const one = approvals.length === 1 ? approvals[0] : null;
      setAttr(el, 'data-maa-approval-id', one?.approvalId);
      setAttr(el, 'data-maa-policy', one?.policySubject);
      setAttr(el, 'data-maa-site', one && destinationOf(one));
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

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(update, 2000);
  schedule();
})();
