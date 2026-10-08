/* Admin — small helpers shared by the Purchases and Location sales editors.
 * ---------------------------------------------------------------------
 *  AdminUI.findProduct(products, text)
 *      Turn what was typed in a product box into a product. Accepts the full
 *      list label, an exact SKU, an exact name, or words that only one product
 *      contains ("layer pellets"). Returns { product, many } where many is the
 *      number of products that matched when there was no single answer.
 *  AdminUI.lineKeys(root, rowSel, lastKey, addRow)
 *      Keyboard flow for a table of lines: Enter moves to the next box, and
 *      Enter in the last box of the last line starts a new line.
 *  AdminUI.guardLeaving(isDirty)
 *      Ask before the browser tab is closed or reloaded with unsaved work.
 */
(function () {
  'use strict';

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

  function findProduct(products, text, labelFn) {
    var t = norm(text);
    if (!t) return { product: null, many: 0 };
    var i, p;
    for (i = 0; i < products.length; i++) if (norm(labelFn(products[i])) === t) return { product: products[i], many: 1 };
    var hits = products.filter(function (q) { return q.sku && norm(q.sku) === t; });
    if (hits.length === 1) return { product: hits[0], many: 1 };
    hits = products.filter(function (q) { return norm(q.name) === t || norm(q.name + ' ' + (q.unit || '')) === t; });
    if (hits.length === 1) return { product: hits[0], many: 1 };
    var words = t.split(' ');
    hits = products.filter(function (q) {
      var hay = norm((q.sku || '') + ' ' + q.name + ' ' + (q.unit || ''));
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    });
    if (hits.length === 1) return { product: hits[0], many: 1 };
    return { product: null, many: hits.length };
  }

  function lineKeys(root, rowSel, lastKey, addRow) {
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      var t = e.target;
      if (!t || t.tagName !== 'INPUT' || !t.closest(rowSel)) return;
      if (t.type === 'checkbox' || t.type === 'date' || t.type === 'file') return;
      e.preventDefault();
      var row = t.closest(rowSel);
      var boxes = Array.prototype.slice.call(row.querySelectorAll('input[data-k]'));
      var at = boxes.indexOf(t);
      if (at >= 0 && at < boxes.length - 1) { boxes[at + 1].focus(); if (boxes[at + 1].select) boxes[at + 1].select(); return; }
      var next = row.nextElementSibling;
      if (next && next.matches(rowSel)) { var first = next.querySelector('input[data-k]'); if (first) first.focus(); return; }
      addRow();
    });
  }

  function guardLeaving(isDirty) {
    window.addEventListener('beforeunload', function (e) {
      if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  window.AdminUI = { findProduct: findProduct, lineKeys: lineKeys, guardLeaving: guardLeaving };
})();
