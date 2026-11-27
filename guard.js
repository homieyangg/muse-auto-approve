'use strict';

// Decides whether the content script may click a card's allow button without the user
const AAG = (() => {
  const aam = typeof AAM !== 'undefined' ? AAM : require('./shared.js');

  // "Allow everything" approves website cards, including browser uploads to a site; posts and other actions are public and
  // can't be undone, so they need the separate switch. Checkouts and purchases are only approved when the user picks "just this once".
  // card.purchase is null when bridge.js gave no fresh answer for the card: an action card may then be a checkout
  // whose wording the text rule misses, so only website cards keep the usual rules
  function canAutoApprove(settings, card, onceOnly) {
    if (onceOnly) return true;
    if (aam.isPurchase(card)) return false;
    if (card.purchase == null && !card.host && !card.site) return false;
    return (settings.mode === 'all' && !!(card.host || card.site || settings.includeActions)) || aam.isTrusted(settings, card);
  }

  // Combines the fresh answers for a combined-card item and its parent card (true, false, or null for no answer)
  function combinePurchase(answers) {
    if (answers.includes(true)) return true;
    return answers.includes(null) ? null : false;
  }

  return { canAutoApprove, combinePurchase };
})();

if (typeof module !== 'undefined') module.exports = AAG;
