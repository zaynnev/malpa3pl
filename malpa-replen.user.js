// ==UserScript==
// @name         Malpa C7 - Replen Early Qty
// @namespace    malpa
// @version      4.4
// @description  Shows replen qty + To Location before scanning; keeps Confirm Units editable but re-checks available stock (get-unallocated-inventory) at execute and blocks over-moves.
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
  let lastAuth = null;       // Authorization header captured from C7's own requests
  const availByInv = {};     // available_quantity seen from get-unallocated-inventory

  console.log(TAG, 'script loaded');

  // ---------------------------------------------------------------------------
  // 1. NETWORK: cache the job list + track the assigned job_id + capture auth
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

  function noteUnalloc(url, text) {
    try {
      const m = url.match(/inventory_id=(\d+)/);
      const j = JSON.parse(text);
      if (m && j && typeof j.available_quantity === 'number') {
        availByInv[m[1]] = j.available_quantity;
      }
    } catch (e) {}
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (String(name).toLowerCase() === 'authorization' && value) lastAuth = value; } catch (e) {}
    return origSetHeader.apply(this, arguments);
  };
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
        } else if (this.__malpaUrl && this.__malpaUrl.indexOf('get-unallocated-inventory') !== -1) {
          noteUnalloc(this.__malpaUrl, this.responseText);
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
    if (!inp.__malpaClearErr) {
      inp.__malpaClearErr = true;
      inp.addEventListener('input', clearError); // safe: no dispatch, just clears the banner
    }
  }

  // ---------------------------------------------------------------------------
  // 2b. AVAILABILITY GUARD  (re-implements C7's get-unallocated-inventory check)
  // ---------------------------------------------------------------------------
  function invIdOf(row) {
    try { if (row.job.replenishmentDetail[0].inventory.id != null) return row.job.replenishmentDetail[0].inventory.id; } catch (e) {}
    try { if (row.job.replenishmentDetail[0].inventory_id != null) return row.job.replenishmentDetail[0].inventory_id; } catch (e) {}
    return null;
  }

  // Live call, at execute time, to the same endpoint C7 uses.
  function fetchAvailable(invId) {
    const url = 'https://stgauth.canary7.com/index.php?r=inventory/inventory/get-unallocated-inventory&inventory_id=' + encodeURIComponent(invId);
    const headers = { 'Accept': 'application/json, text/plain, */*' };
    if (lastAuth) headers['Authorization'] = lastAuth;
    return (origFetch || window.fetch)(url, { headers, credentials: 'omit' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => {
        if (j && typeof j.available_quantity === 'number') { availByInv[invId] = j.available_quantity; return j.available_quantity; }
        throw new Error('no available_quantity in response');
      });
  }

  function errorHost() {
    const chs = document.querySelectorAll('.card-header');
    for (const h of chs) if (h.textContent.trim().indexOf('Replenishment Job Execution') === 0) return h;
    return chs[0] || null;
  }
  function showError(msg) {
    let el = document.getElementById('malpa-qty-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'malpa-qty-error';
      el.style.cssText = 'background:#c0392b;color:#fff;font-weight:bold;padding:8px 12px;margin:8px;border-radius:4px;font-size:1.05em;';
      const host = errorHost();
      if (host && host.parentNode) host.parentNode.insertBefore(el, host.nextSibling);
      else document.body.insertBefore(el, document.body.firstChild);
    }
    el.textContent = '\u26A0 ' + msg;
    console.warn(TAG, 'BLOCKED:', msg);
  }
  function clearError() {
    const el = document.getElementById('malpa-qty-error');
    if (el) el.remove();
  }

  function findNextBtn() {
    const btns = document.querySelectorAll('button');
    for (const b of btns) if (b.textContent.trim() === 'Next') return b;
    return null;
  }

  let bypassGuard = false; // set true when WE re-dispatch a validated click
  let inFlight = false;    // an availability check is running

  function onNextCapture(e) {
    // Our own validated re-click passes straight through.
    if (bypassGuard) { bypassGuard = false; return; }
    if (!onReplenExecScreen()) return;

    const inp = findQtyInput();
    if (!inp || inp.value === '') return;      // nothing to validate (e.g. item-scan step)
    const qty = parseInt(inp.value, 10);
    if (isNaN(qty)) return;

    const btn = e.currentTarget || findNextBtn();
    const row = currentJob();
    const invId = row ? invIdOf(row) : null;
    const planned = row ? qtyOf(row) : null;
    const fromCode = (row && row.fromLocation && row.fromLocation.location_code) ||
                     valueOf(findByLabel('From Location :'), 'From Location :') || 'the from-location';

    // Block the execute until we've verified. FAIL CLOSED from here on.
    e.preventDefault();
    e.stopImmediatePropagation();

    if (inFlight) return;

    if (invId == null) {
      // Can't identify the inventory to check. Only let through the known-safe
      // planned quantity; block anything above it.
      if (planned != null && qty <= planned) { proceed(btn); }
      else { showError('Cannot verify available stock for this item \u2014 move blocked.'); inp.focus(); }
      return;
    }

    inFlight = true;
    fetchAvailable(invId).then(avail => {
      inFlight = false;
      if (qty > avail) {
        showError('Only ' + avail + ' available at ' + fromCode + ' \u2014 you entered ' + qty + '. Reduce the quantity.');
        inp.focus(); if (inp.select) inp.select();
      } else {
        clearError();
        proceed(btn);
      }
    }).catch(err => {
      inFlight = false;
      console.warn(TAG, 'availability check failed', err);
      showError('Could not verify available stock \u2014 move blocked. Check connection and try again.');
    });
  }

  function proceed(btn) {
    bypassGuard = true;
    (btn || findNextBtn()).click();
  }

  function attachGuard() {
    const btn = findNextBtn();
    if (!btn || btn.__malpaGuard) return;
    btn.__malpaGuard = true;
    btn.addEventListener('click', onNextCapture, true); // capture phase, before Angular
    console.log(TAG, 'availability guard attached to Next');
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

  // True only on the actual Replenishment Job Execution screen (the receiving
  // screen also shows an item description, so we gate on this card header).
  function onReplenExecScreen() {
    const headers = document.querySelectorAll('.card-header, .card-header strong, strong');
    for (const h of headers) {
      if (h.textContent.trim() === 'Replenishment Job Execution') return true;
    }
    return false;
  }

  function sync() {
    try {
      if (!onReplenExecScreen()) { removeQtyLine(); return; }

      keepQtyUnlocked();
      attachGuard();

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
