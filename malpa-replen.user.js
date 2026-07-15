// ==UserScript==
// @name         Malpa C7 - Replen Early Qty
// @namespace    malpa
// @version      4.2
// @description  Shows replenishment qty-to-move + To Location before scanning, and keeps the Confirm Units field editable so a changed qty is submitted.
// @match        https://malpa.canary7.com/*
// @grant        none
// @homepageURL  https://github.com/zaynnev/malpa3pl
// @supportURL   https://github.com/zaynnev/malpa3pl/issues
// @updateURL    https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-replen.user.js
// @downloadURL  https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-replen.user.js
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[Malpa Replen]';
  const QTY_ID = 'malpa-qty-line';

  const jobsById = {};       // every get-replenishment-jobs row, keyed by row id
  let currentJobId = null;   // job_id from the latest assign-replenishment-job call

  console.log(TAG, 'script loaded');

  // ---------------------------------------------------------------------------
  // 1. NETWORK: cache the job list + track the assigned job_id
  // ---------------------------------------------------------------------------
  function cacheJobs(data) {
    if (!Array.isArray(data)) return;
    data.forEach(j => { if (j && j.id != null) jobsById[j.id] = j; });
    console.log(TAG, 'cached', data.length, 'jobs (total known:', Object.keys(jobsById).length + ')');
  }

  function noteAssign(url) {
    const m = url && url.match(/[?&]job_id=(\d+)/);
    if (m) {
      currentJobId = parseInt(m[1], 10);
      console.log(TAG, 'assigned job_id =', currentJobId);
      const l = document.getElementById(QTY_ID);
      if (l) l.remove(); // force redraw for the new job
    }
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) {
    this.__malpaUrl = url;
    if (url && url.indexOf('assign-replenishment-job') !== -1) noteAssign(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        if (this.__malpaUrl && this.__malpaUrl.indexOf('get-replenishment-jobs') !== -1) {
          cacheJobs(JSON.parse(this.responseText));
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
        if (url && url.indexOf('assign-replenishment-job') !== -1) noteAssign(url);
      } catch (e) {}
      return origFetch.apply(this, args).then((res) => {
        try {
          const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
          if (url && url.indexOf('get-replenishment-jobs') !== -1) {
            res.clone().json().then(cacheJobs).catch(() => {});
          }
        } catch (e) {}
        return res;
      });
    };
  }

  // ---------------------------------------------------------------------------
  // 2. DOM HELPERS
  // ---------------------------------------------------------------------------
  function findByLabel(prefix) {
    const p = prefix.toLowerCase().replace(/\s+/g, ' ');
    let best = null, bestLen = Infinity;
    const els = document.querySelectorAll('div, label, span, strong, p, dt, dd');
    for (const el of els) {
      const t = el.textContent.trim().replace(/\s+/g, ' ').toLowerCase();
      if (t.startsWith(p)) {
        const len = el.textContent.trim().length;
        if (len < bestLen) { best = el; bestLen = len; }
      }
    }
    return best;
  }

  function valueOf(el, prefix) {
    if (!el) return null;
    const strong = el.querySelector('strong');
    if (strong && strong.textContent.trim()) return strong.textContent.trim();
    return el.textContent.trim().slice(prefix.length).replace(/^[\s:]+/, '').trim();
  }

  // Smallest element whose text CONTAINS the label (handles the label being a
  // raw text node, e.g. Item + Description sharing one form-group block).
  function findContainer(substr) {
    const s = substr.toLowerCase().replace(/\s+/g, ' ');
    let best = null, bestLen = Infinity;
    const els = document.querySelectorAll('div, label, span, strong, p, dt, dd');
    for (const el of els) {
      const t = el.textContent.replace(/\s+/g, ' ').toLowerCase();
      if (t.includes(s)) {
        const len = el.textContent.trim().length;
        if (len < bestLen) { best = el; bestLen = len; }
      }
    }
    return best;
  }

  // The Confirm Units input (reactive form control "quantity", id like txt_qty7).
  function findQtyInput() {
    return document.querySelector('input[formcontrolname="quantity"]') ||
           document.querySelector('input[id^="txt_qty"]');
  }

  // Keep the Confirm Units field editable. Typing fires the input's native
  // input/change events, which Angular's reactive form already listens to, so
  // the edited qty is submitted without any extra event dispatching from us.
  function keepQtyUnlocked() {
    const inp = findQtyInput();
    if (!inp) return;
    if (inp.hasAttribute('readonly') || inp.readOnly) {
      inp.removeAttribute('readonly');
      inp.readOnly = false;
      if (!inp.__malpaUnlocked) { inp.__malpaUnlocked = true; console.log(TAG, 'qty field editable'); }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. FIND THE CURRENTLY-LOADED JOB
  // ---------------------------------------------------------------------------
  function currentJob() {
    const rows = Object.values(jobsById);
    if (!rows.length) return null;

    // Best: the job the assign call told us about.
    if (currentJobId != null) {
      const r = rows.find(x => x.job_id === currentJobId || (x.job && x.job.id === currentJobId));
      if (r) return r;
    }
    // Fallback: match the From Location shown on screen.
    const fromCode = valueOf(findByLabel('From Location :'), 'From Location :');
    if (fromCode) {
      const r = rows.find(x => x.fromLocation && x.fromLocation.location_code === fromCode);
      if (r) return r;
    }
    // Fallback: match the Item shown on screen.
    const itemCode = valueOf(findByLabel('Item :'), 'Item :');
    if (itemCode) {
      const r = rows.find(x => x.item && x.item.item_code === itemCode);
      if (r) return r;
    }
    return null;
  }

  function qtyOf(row) {
    try { if (row.job.replenishmentDetail[0].quantity != null) return row.job.replenishmentDetail[0].quantity; } catch (e) {}
    return row.quantity;
  }
  function uomOf(row) {
    try { return row.job.replenishmentDetail[0].inventory.itemUnitOfMeasure.unitOfMeasure.name || 'units'; } catch (e) {}
    return 'units';
  }

  // ---------------------------------------------------------------------------
  // 4. RENDER
  // ---------------------------------------------------------------------------
  function removeQtyLine() {
    const l = document.getElementById(QTY_ID);
    if (l) l.remove();
  }

  function sync() {
    try {
      keepQtyUnlocked();

      const anchor = findContainer('Description :') || findContainer('From Location :') || findContainer('Item :');
      if (!anchor) { removeQtyLine(); return; }

      const row = currentJob();
      if (!row) {
        if (Object.keys(jobsById).length) console.log(TAG, 'no matching job yet');
        removeQtyLine();
        return;
      }

      const key = String(row.id);
      const existing = document.getElementById(QTY_ID);
      if (existing && existing.dataset.key === key && document.contains(existing)) return;
      if (existing) existing.remove();

      const qty = qtyOf(row);
      const uom = uomOf(row);
      const toLoc = (row.toLocation && row.toLocation.location_code) || '';
      const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

      // Wrapper is display:contents so the two rows sit in flow exactly like the
      // native fields; each row reuses C7's own .form-group markup + <strong> so
      // it inherits the site's colour, weight and spacing (no custom styling).
      const line = document.createElement('div');
      line.id = QTY_ID;
      line.dataset.key = key;
      line.style.display = 'contents';
      line.innerHTML =
        '<div class="form-group ng-star-inserted">Qty to move : <strong>' + esc(qty) + ' \u00D7 ' + esc(uom) + '</strong></div>' +
        (toLoc ? '<div class="form-group ng-star-inserted">To Location : <strong>' + esc(toLoc) + '</strong></div>' : '');

      anchor.parentNode.insertBefore(line, anchor.nextSibling);
      console.log(TAG, 'Qty line added:', qty, uom, 'to', toLoc, '(job', row.job_id + ', item', (row.item && row.item.item_code) + ')');
    } catch (e) {
      console.warn(TAG, 'sync error', e);
    }
  }

  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
  setInterval(sync, 600);
  sync();
  console.log(TAG, 'observer + poll running');
})();
