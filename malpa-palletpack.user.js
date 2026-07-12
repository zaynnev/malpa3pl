// ==UserScript==
// @name         Malpa Pallet Pack
// @namespace    malpa
// @version      1.2.5
// @match        https://*.canary7.com/*
// @updateURL    https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-palletpack.user.js
// @downloadURL  https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-palletpack.user.js
// @grant        none
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MALPA PALLET PACK  —  blind verification + deferred pack for Canary7 WMS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Flow (see build guide §0):
 *    1. Operator picks a packing profile.
 *    2. Operator scans a shipment number (Pack Pending / status 5). Every line is
 *       loaded into a LOCAL cache (required base qty, UOM factors, barcodes, weights).
 *    3. Operator BLIND-scans every physical unit. Outer-UOM barcodes count by their
 *       `factor` (one outer scan = +48 base units). Nothing on screen reveals the
 *       required counts.
 *    4. Operator taps Close Container per physical box (enters weight/dimensions).
 *    5. Operator taps Finish Verification.
 *
 *  *** NO C7 WRITE CALLS FIRE UNTIL FINISH. ***  Scanning, container boundaries and
 *  weight/dim entry are all local. At Finish the script does a local total-vs-required
 *  match:
 *    • MISMATCH → show the diff, reset scanned state, restart (nothing committed).
 *    • MATCH    → commit per container (create → move/pack children → close), which
 *                 leaves the shipment at Consigning Pending (status 7).
 *
 *  This script NEVER calls create-consignment-pieces. The desk consigns.
 *
 *  Scaffolding lifted from Malpa Pick v4.8.9 (session/nav/focus/audio) and
 *  Malpa Pack v3.3.78 (APIQueue + create/move/pack-short-v2/close call shapes).
 *
 *  v1.2.3 — Shell now uses Malpa Pick's native tab-pane model: the view is injected
 *  as a real .tab-pane inside C7's div.tab-content (not a fixed overlay), so it fills
 *  the content area automatically and reflows when the sidebar collapses. Height is
 *  measured in JS (measureHeight); width is handled by C7's own flow. Removes the old
 *  positionRoot / tab-poll / mutation-observer overlay machinery.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ===========================================================================
  // 0. CONSTANTS  (build guide §4/§5 — confirm production values before rollout)
  // ===========================================================================

  // API host: same as Malpa Pick v4.8.9 / Pack v3.3.78. On production the UI at
  // malpa.canary7.com is a static Angular app (S3/CloudFront — calling index.php
  // there returns an XML AccessDenied 403); the Canary7 API itself is served from
  // stgauth.canary7.com, which is what both proven sibling scripts call.
  const API_BASE         = 'https://stgauth.canary7.com/index.php?r=';
  const WAREHOUSE_ID     = 10;      // guide §5 — HAR shows 10; CONFIRM for production
  const PACK_LOCATION_ID = 72037;   // guide §3 D5 / §5 — packing/close location (code WDD-02); per-station constant, CONFIRM

  // get-pack-container expand for the commit context resolve (guide §3 D4)
  const PP_GPC_EXPAND = [
    'shipmentHeader', 'jobInstruction',
    'shipmentDetailChildren.shipmentDetail.item.itemUnitOfMeasures.unitOfMeasure',
    'shipmentDetailChildren.itemUnitOfMeasure',
  ].join(',');

  const LOG = (...a) => console.log('[MalpaPalletPack]', ...a);
  const WARN = (...a) => console.warn('[MalpaPalletPack]', ...a);

  // ===========================================================================
  // 1. AUTH + API LAYER  (copied from Pick §1)
  // ===========================================================================

  function getToken() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (const key of ['access_token', 'token', 'id_token', 'auth_token']) {
          const v = store.getItem(key);
          if (v && v.length > 20) return v;
        }
      } catch (_) {}
    }
    return null;
  }

  let _sessionId = null;

  function captureSessionId() {
    if (_sessionId) return;
    // Check storage first for a numeric session/shift value
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          const val = store.getItem(key);
          if (
            key &&
            (key.toLowerCase().includes('session') || key.toLowerCase().includes('shift')) &&
            val && /^\d+$/.test(val.trim())
          ) {
            _sessionId = val.trim();
            return;
          }
        }
      } catch (_) {}
    }
    // Intercept the next Angular XHR to steal x-session-id from its headers
    if (!window._mppXHRPatched) {
      window._mppXHRPatched = true;
      const origSet = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name.toLowerCase() === 'x-session-id' && value && !_sessionId) {
          _sessionId = String(value);
          XMLHttpRequest.prototype.setRequestHeader = origSet;
          window._mppXHRPatched = false;
        }
        return origSet.call(this, name, value);
      };
    }
  }

  function mkHeaders(extra = {}) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${getToken()}`,
      'x-warehouse-id': String(WAREHOUSE_ID),
      ...extra,
    };
    if (_sessionId) h['x-session-id'] = _sessionId;
    return h;
  }

  async function waitForSession() {
    if (_sessionId) return;
    captureSessionId();
    for (let i = 0; i < 5 && !_sessionId; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  async function apiGet(path) {
    await waitForSession();
    const res = await fetch(API_BASE + path, { method: 'GET', headers: mkHeaders() });
    if (res.status === 401) { _showSessionExpired(); throw new Error('Session expired'); }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.message || `API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function apiPost(path, data) {
    await waitForSession();
    const res = await fetch(API_BASE + path, {
      method: 'POST', headers: mkHeaders(), body: JSON.stringify(data),
    });
    if (res.status === 401) { _showSessionExpired(); throw new Error('Session expired'); }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.message || `API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Session expiry — overlay whatever screen is active, reset to profile select
  let _sessionExpiredShown = false;
  function _showSessionExpired() {
    if (_sessionExpiredShown) return;
    _sessionExpiredShown = true;
    const root = document.getElementById('mpp-root');
    if (!root) { _sessionExpiredShown = false; return; }
    const banner = document.createElement('div');
    banner.className = 'mpp-overlay';
    banner.innerHTML = `
      <div class="mpp-modal" style="text-align:center">
        <div class="mpp-modal-title" style="text-align:center">🔒 Session Expired</div>
        <div class="mpp-note">Your C7 session has timed out.<br>Log back in to continue packing.</div>
        <button id="mpp-session-dismiss" class="mpp-btn mpp-btn-primary" style="margin-top:4px">Dismiss</button>
      </div>`;
    root.appendChild(banner);
    document.getElementById('mpp-session-dismiss')?.addEventListener('click', () => {
      banner.remove();
      _sessionExpiredShown = false;
      resetAll();
      renderProfileSelect();
    });
  }

  // ===========================================================================
  // 2. API QUEUE  (copied from Pack §2 — concurrency-limited, retry, keyed dedupe)
  // ===========================================================================

  class APIQueue {
    constructor({ concurrency = 3, maxRetries = 3 } = {}) {
      this._concurrency = concurrency;
      this._maxRetries  = maxRetries;
      this._queue       = [];
      this._running     = 0;
      this._inFlight    = new Set();
    }
    enqueue({ key, fn, onSuccess, onFailure, priority = 0 }) {
      if (key && this._inFlight.has(key)) return Promise.resolve(null);
      if (key) this._inFlight.add(key);
      return new Promise((resolve, reject) => {
        this._queue.push({ key, fn, onSuccess, onFailure, priority, resolve, reject, attempt: 0 });
        this._queue.sort((a, b) => b.priority - a.priority);
        this._tick();
      });
    }
    _tick() {
      while (this._running < this._concurrency && this._queue.length) {
        const task = this._queue.shift();
        this._running++;
        this._run(task);
      }
    }
    async _run(task) {
      try {
        const result = await task.fn();
        if (task.key) this._inFlight.delete(task.key);
        task.onSuccess && task.onSuccess(result);
        task.resolve(result);
      } catch (err) {
        // job/"null"/completePacking errors are not retryable (guide §2.3 / §15)
        const nonRetryable = err.message && (
          err.message.includes('completePacking') ||
          err.message.includes('packShortV2') ||
          err.status === 401
        );
        task.attempt++;
        if (!nonRetryable && task.attempt < this._maxRetries) {
          const delay = 500 * Math.pow(2, task.attempt - 1);
          await new Promise(r => setTimeout(r, delay));
          this._queue.unshift(task);
        } else {
          if (task.key) this._inFlight.delete(task.key);
          task.onFailure && task.onFailure(err);
          task.reject(err);
        }
      } finally {
        this._running--;
        this._tick();
      }
    }
  }
  const Q = new APIQueue({ concurrency: 4, maxRetries: 3 });
  // Route a call through the queue and await it (retry + dedupe, but the caller
  // still serialises per container — child-split ids chain, guide §12).
  const qCall = (key, fn) => Q.enqueue({ key, fn });

  // ===========================================================================
  // 3. STATE + BLIND CACHE  (guide §8 — all local until Finish)
  // ===========================================================================

  const State = {
    screen: 'PROFILE',           // PROFILE | SHIPMENT_ENTRY | SCAN | COMMITTING | SUCCESS
    profile: null,               // chosen packing profile object
    profiles: [],
    containerTypes: [],
    containerPrefixes: [],       // [{ prefix, typeId, name }] sorted longest-first
    voiceEnabled: (() => {
      try { const v = sessionStorage.getItem('mpp_voice'); return v === null ? true : v === '1'; }
      catch (_) { return true; }
    })(),
    committing: false,           // re-entry guard for Finish/commit (guide §13/§15)
  };

  function newContainer(seq) {
    return {
      seq,
      containerNo: null,
      containerTypeId: null,
      lines: new Map(),          // item_id -> base units placed in THIS box
      weight: null, length: null, width: null, height: null,
    };
  }

  const Cache = {
    shipmentNumber: null,
    shipmentHeaderId: null,
    items: new Map(),            // item_id -> { itemCode, description, requiredBase, scannedBase, unitWeight }
    barcodeIndex: new Map(),     // UPPER(barcode) -> { itemId, factor, uomId }
    unexpected: new Map(),       // UPPER(barcode) -> count
    containers: [],              // finalised Container boundaries
    current: null,               // the box being filled now

    reset() {
      this.shipmentNumber = null;
      this.shipmentHeaderId = null;
      this.items = new Map();
      this.barcodeIndex = new Map();
      this.unexpected = new Map();
      this.containers = [];
      this.current = newContainer(1);
    },
    // Reset only scanned state (guide §13) — keep item requirements + barcodeIndex
    resetScans() {
      for (const it of this.items.values()) it.scannedBase = 0;
      this.unexpected = new Map();
      this.containers = [];
      this.current = newContainer(1);
    },
  };

  // Full reset back to shipment entry (keeps profile selected — guide §13)
  function resetForNextShipment() {
    Cache.reset();
    State.committing = false;
    renderShipmentEntry();
  }
  // Full reset back to profile select
  function resetAll() {
    Cache.reset();
    State.committing = false;
    State.screen = 'PROFILE';
  }

  // ===========================================================================
  // 4. AUDIO / VOICE  (copied from Pick §Audio — minimal so nothing leaks counts)
  // ===========================================================================

  const Audio = {
    _ctx: null,
    init() {
      if (this._ctx) return;
      try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { WARN('AudioContext unavailable:', e.message); }
    },
    _tone(freq, duration, type = 'sine', gainVal = 0.4, startDelay = 0) {
      if (!this._ctx) return;
      try {
        const osc = this._ctx.createOscillator();
        const gain = this._ctx.createGain();
        osc.connect(gain); gain.connect(this._ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this._ctx.currentTime + startDelay);
        gain.gain.setValueAtTime(gainVal, this._ctx.currentTime + startDelay);
        gain.gain.exponentialRampToValueAtTime(0.001, this._ctx.currentTime + startDelay + duration);
        osc.start(this._ctx.currentTime + startDelay);
        osc.stop(this._ctx.currentTime + startDelay + duration);
      } catch (e) { /* ignore */ }
    },
    chime(type) {
      this.init();
      if (!this._ctx) return;
      if (this._ctx.state === 'suspended') this._ctx.resume();
      if (type === 'scan')        { this._tone(880, 0.12, 'sine', 0.32, 0); }              // every scan (blind — same for hit/miss)
      else if (type === 'ok')     { this._tone(660, 0.12, 'sine', 0.3, 0); this._tone(880, 0.2, 'sine', 0.4, 0.13); }
      else if (type === 'error')  { this._tone(180, 0.08, 'square', 0.3, 0); this._tone(180, 0.08, 'square', 0.3, 0.12); }
    },
  };

  const Voice = {
    speak(text) {
      if (!State.voiceEnabled || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.rate = 1.7; u.pitch = 1.0; u.volume = 1.0;
      window.speechSynthesis.speak(u);
    },
    // Errors bypass the mute toggle
    error(text) {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.rate = 1.6; u.pitch = 1.0; u.volume = 1.0;
      window.speechSynthesis.speak(u);
    },
  };

  function vibrate(pattern) { if (navigator.vibrate) try { navigator.vibrate(pattern); } catch (_) {} }

  // ===========================================================================
  // 5. HELPERS
  // ===========================================================================

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Shipment number encoding for query strings (## → %23%23, guide §7)
  function encShip(num) { return String(num).trim().replace(/#/g, '%23'); }

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  // Longest-prefix container-type match (guide §14)
  function containerTypeFromNumber(no) {
    const up = String(no || '').trim().toUpperCase();
    if (!up) return null;
    for (const p of State.containerPrefixes) {   // already sorted longest-first
      if (p.prefix && up.startsWith(p.prefix)) return p;
    }
    return null;
  }

  // ===========================================================================
  // 6. DATA FETCHES  (guide §6/§7)
  // ===========================================================================

  async function fetchProfiles() {
    // Need verifications[] (guide §2.3 verification id 4) + jobTypes + container flags
    const data = await apiGet(
      'configuration/shipment-packing-profile' +
      '&expand=verifications,jobTypes&per-page=100&page=1'
    );
    return Array.isArray(data) ? data : (data?.items || []);
  }

  async function fetchContainerTypes() {
    const data = await apiGet('configuration/container-type&per-page=100&page=1');
    return Array.isArray(data) ? data : (data?.items || []);
  }

  let _initStarted = false;
  async function initData() {
    if (_initStarted && State.profiles.length) return;
    _initStarted = true;
    try {
      const [profiles, types] = await Promise.all([fetchProfiles(), fetchContainerTypes()]);
      State.profiles = profiles || [];
      State.containerTypes = types || [];
      buildContainerPrefixes();
      LOG('initData OK — profiles:', State.profiles.length, 'types:', State.containerTypes.length);
      if (State.screen === 'PROFILE') renderProfileSelect();
    } catch (err) {
      WARN('initData failed:', err.message);
      _initStarted = false;
      if (State.screen === 'PROFILE') renderProfileSelect('Could not load profiles: ' + err.message);
    }
  }

  function buildContainerPrefixes() {
    State.containerPrefixes = State.containerTypes
      .map(ct => ({
        prefix: (ct.container_number_prefix || '').toUpperCase(),
        typeId: ct.id,
        name: ct.name || ct.description || `Type ${ct.id}`,
      }))
      .filter(p => p.prefix)
      .sort((a, b) => b.prefix.length - a.prefix.length);   // longest-prefix-match
  }

  // True when the selected profile only accepts UOM-reference barcodes (guide §2.3, id 4)
  function profileOnlyAcceptsReference() {
    const v = State.profile?.verifications || [];
    return v.some(x => (x.id ?? x.verification_id) === 4 || /only accept reference/i.test(x.name || ''));
  }

  // ===========================================================================
  // 7. SHIPMENT LOAD  (guide §7 — widened expand/fields, build blind cache §8)
  // ===========================================================================

  async function loadShipment(shipmentNumber) {
    const enc = encShip(shipmentNumber);
    const expand = [
      'shipmentHeader',
      'item.itemUnitOfMeasures.unitOfMeasure',
      'item.itemUnitOfMeasures.itemUnitOfMeasureReference',
    ].join(',');
    const fields = [
      'id', 'quantity', 'original_qty',
      'shipment_header.id', 'shipment_header.shipment_number',
      'shipment_header.leading_status_id',
      'item.id', 'item.item_code', 'item.description',
      'item.itemUnitOfMeasures.id', 'item.itemUnitOfMeasures.factor',
      'item.itemUnitOfMeasures.weight', 'item.itemUnitOfMeasures.unitOfMeasure.name',
      'item.itemUnitOfMeasures.itemUnitOfMeasureReference.reference',
    ].join(',');

    const data = await apiGet(
      `shipment/shipment-detail&shipment_number=${enc}` +
      `&expand=${expand}&fields=${fields}&per-page=200&page=1`
    );
    const lines = Array.isArray(data) ? data : (data?.items || []);
    if (!lines.length) { const e = new Error('Shipment not found.'); e.code = 'NOT_FOUND'; throw e; }

    // Guard on the SHIPMENT-HEADER leading status (the authoritative "Pack Pending"
    // signal — guide §7/§15). Detail rows don't reliably carry a leading status, so
    // reading it per-line gave false negatives. Only block when we can POSITIVELY
    // read a status that isn't 5; if it's absent, proceed rather than false-block.
    // C7 returns an EXPANDed relation under its camelCase name (`shipmentHeader`),
    // not `shipment_header`. Reading the snake_case key left shipmentHeaderId undefined,
    // so the create body omitted shipment_header_id → the container had no shipment
    // link → close-to-container 500'd on `shipmentHeader->statusFlow`. Read camelCase
    // first, snake_case as a fallback.
    const hdr = lines[0].shipmentHeader || lines[0].shipment_header || {};
    const rawStatus = hdr.leading_status_id ?? hdr.leadingStatus?.id ?? hdr.leadingStatus;
    const status = (rawStatus === undefined || rawStatus === null || rawStatus === '')
      ? null : Number(rawStatus);
    if (status !== null && status !== 5) {
      const e = new Error(`Shipment is not Pack Pending — current status ${status}. Cannot load.`);
      e.code = 'BAD_STATUS';
      throw e;
    }
    if (status === null) WARN('Could not read shipment leading status from detail response — proceeding.');

    // Build the blind cache (guide §8)
    Cache.reset();
    Cache.shipmentNumber = hdr.shipment_number || shipmentNumber;
    Cache.shipmentHeaderId = hdr.id;
    if (Cache.shipmentHeaderId == null) WARN('shipment_header id not found in load response — create/close will fail.');

    const onlyRef = profileOnlyAcceptsReference();
    let uomModelMissing = false;

    for (const ln of lines) {
      const item = ln.item || {};
      const itemId = item.id ?? item.item_code;
      if (itemId == null) continue;
      const uoms = item.itemUnitOfMeasures || [];
      if (!uoms.length) uomModelMissing = true;

      // Aggregate required base qty by item (guide §8 — totals only, child ids volatile)
      let entry = Cache.items.get(itemId);
      if (!entry) {
        entry = {
          itemCode: item.item_code || String(itemId),
          description: item.description || '',
          requiredBase: 0,
          scannedBase: 0,
          unitWeight: computeUnitWeight(uoms),
        };
        Cache.items.set(itemId, entry);
      }
      entry.requiredBase += num(ln.quantity);

      // Build barcodeIndex from UOM references (guide §8)
      for (const u of uoms) {
        const factor = num(u.factor) || 1;
        const uomId = u.id;
        for (const ref of (u.itemUnitOfMeasureReference || [])) {
          const code = (ref.reference || '').trim().toUpperCase();
          if (code) Cache.barcodeIndex.set(code, { itemId, factor, uomId });
        }
      }
      // Bare item_code → factor 1, UNLESS profile is Only-Accept-Reference (guide §2.3)
      if (!onlyRef && item.item_code) {
        const code = String(item.item_code).trim().toUpperCase();
        if (!Cache.barcodeIndex.has(code)) {
          const baseUom = uoms.find(u => (num(u.factor) || 1) === 1) || uoms[0];
          Cache.barcodeIndex.set(code, { itemId, factor: 1, uomId: baseUom?.id });
        }
      }
    }

    if (uomModelMissing) {
      // Guide §7 fallback note: if the widened expand/fields don't return UOM data,
      // the per-item factor/barcode model is incomplete. Surface it rather than
      // silently packing with a broken barcode index.
      WARN('Some lines returned no itemUnitOfMeasures — UOM factors/barcodes may be incomplete.');
    }
    LOG('Loaded shipment', Cache.shipmentNumber, '— items:', Cache.items.size,
        'barcodes:', Cache.barcodeIndex.size);
  }

  // unitWeight = base-unit (factor 1) UOM weight; else derive from an outer UOM (weight/factor)
  function computeUnitWeight(uoms) {
    const base = uoms.find(u => (num(u.factor) || 1) === 1);
    if (base && num(base.weight) > 0) return num(base.weight);
    for (const u of uoms) {
      const f = num(u.factor) || 1;
      if (num(u.weight) > 0 && f > 0) return num(u.weight) / f;
    }
    return 0;
  }

  // ===========================================================================
  // 8. SCAN HANDLING  (guide §9 — client-side only, never fires an API call)
  // ===========================================================================

  function onScan(raw) {
    if (State.screen === 'SHIPMENT_ENTRY') { onShipmentScan(raw); return; }
    if (State.screen !== 'SCAN') return;

    const code = String(raw || '').trim().toUpperCase();
    if (!code) return;

    const hit = Cache.barcodeIndex.get(code);
    if (hit) {
      const it = Cache.items.get(hit.itemId);
      if (it) it.scannedBase += hit.factor;
      Cache.current.lines.set(hit.itemId, (Cache.current.lines.get(hit.itemId) || 0) + hit.factor);
    } else {
      // Unknown — record as unexpected, but give the SAME success feedback (stay
      // blind, never signal wrong). Guarantees Finish fails. (guide decision #2)
      Cache.unexpected.set(code, (Cache.unexpected.get(code) || 0) + 1);
    }
    // Identical feedback for hit and miss — do NOT leak correctness
    Audio.chime('scan');
    vibrate([30]);
    flashScan();
    updateScanScreenMeta();
  }

  // ===========================================================================
  // 9. UI SHELL / SCREENS
  // ===========================================================================

  function root() { return document.getElementById('mpp-root'); }

  const _SCAN_SCREENS = { SHIPMENT_ENTRY: 'mpp-ship-in', SCAN: 'mpp-scan-in' };

  let _mppViewVisible = false;

  // TC51 sidebar state + the native tab/pane active before we opened (restored on close).
  let _mppSidebarWasMin = false;
  let _mppBrandWasMin   = false;
  let _prevActiveLi     = null;
  let _prevActivePanel  = null;

  // Height = window height minus our top offset. Width needs no JS — the panel is a
  // native .tab-pane in C7's flow, so it fills the content area and reflows when the
  // sidebar collapses. (Mirrors malpa-pick.user.js measureHeight.)
  function measureHeight() {
    const panel = document.getElementById('mpp-root');
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const available = Math.floor(window.innerHeight - rect.top);
    if (available > 100) {
      panel.style.height    = available + 'px';
      panel.style.maxHeight = available + 'px';
      panel.style.minHeight = available + 'px';
    }
  }

  function _deactivateNative(tabBar, tabContent) {
    tabBar.querySelectorAll('li.nav-item').forEach(li => {
      if (li.id === 'mpp-tab-li') return;
      li.classList.remove('active');
      const a = li.querySelector('a.nav-link');
      if (a) { a.classList.remove('active'); a.setAttribute('aria-selected', 'false'); }
    });
    tabContent.querySelectorAll(':scope > tab, :scope > .tab-pane').forEach(p => {
      if (p.id === 'mpp-root') return;
      p.classList.remove('active');
      p.style.display = 'none';
    });
  }

  function openUI() {
    if (document.getElementById('mpp-root')) { showRoot(); return; }
    injectCSS();

    const tabBar     = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    const tabContent = document.querySelector('div.tab-content');
    if (!tabBar || !tabContent) { WARN('Could not find C7 tab bar or tab content.'); return; }

    // Remember what was active so closeUI() restores it exactly.
    const prevLi    = tabBar.querySelector('li.nav-item.active');
    const prevPanel = tabContent.querySelector(':scope > .tab-pane.active, :scope > tab.active');
    if (prevLi)    _prevActiveLi    = prevLi;
    if (prevPanel) _prevActivePanel = prevPanel;

    // Tab chip in C7's tab bar.
    const li = document.createElement('li');
    li.id = 'mpp-tab-li';
    li.className = 'nav-item ng-star-inserted active';
    const a = document.createElement('a');
    a.className = 'nav-link active';
    a.href = 'javascript:void(0);';
    a.setAttribute('role', 'tab');
    a.setAttribute('aria-selected', 'true');
    a.innerHTML = '<span class="mpp-tab-label">Pallet Pack</span>' +
                  '<span class="mpp-tab-x" title="Close Pallet Pack">×</span>';
    a.addEventListener('click', (e) => {
      if (e.target.closest('.mpp-tab-x')) { e.preventDefault(); e.stopPropagation(); confirmClose(); return; }
      e.preventDefault();
      showRoot();
    });
    li.appendChild(a);
    tabBar.appendChild(li);

    // Panel as a native .tab-pane inside tab-content — THIS is what fills the screen.
    const overlay = document.createElement('div');
    overlay.id = 'mpp-root';
    overlay.className = 'mpp-root tab-pane active';
    overlay.style.display = 'flex';   // inline beats any C7 .tab-pane.active{display:block}
    tabContent.appendChild(overlay);

    _deactivateNative(tabBar, tabContent);

    // Minimise the C7 sidebar for max TC51 space; store prior state to restore later.
    _mppSidebarWasMin = document.body.classList.contains('sidebar-minimized');
    _mppBrandWasMin   = document.body.classList.contains('brand-minimized');
    document.body.classList.add('sidebar-minimized', 'brand-minimized');

    document.addEventListener('keydown', onGlobalKey, true);
    setTimeout(measureHeight, 50);
    window.addEventListener('resize', measureHeight);

    _mppViewVisible = true;
    if (!State.profiles.length) { initData(); renderProfileSelect('Loading profiles…'); }
    else renderProfileSelect();
  }

  // ── Native C7 tab-bar integration (mirrors Malpa Pick) ──────────────────────
  // Re-show after the operator clicked away to a native C7 tab.
  function showRoot() {
    const tabBar     = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    const tabContent = document.querySelector('div.tab-content');
    const r  = document.getElementById('mpp-root');
    const li = document.getElementById('mpp-tab-li');
    if (!r || !tabBar || !tabContent) return;
    const prevLi    = tabBar.querySelector('li.nav-item.active:not(#mpp-tab-li)');
    const prevPanel = tabContent.querySelector(':scope > .tab-pane.active:not(#mpp-root), :scope > tab.active');
    if (prevLi)    _prevActiveLi    = prevLi;
    if (prevPanel) _prevActivePanel = prevPanel;
    _deactivateNative(tabBar, tabContent);
    r.classList.add('active'); r.style.display = 'flex';
    if (li) { li.classList.add('active'); const la = li.querySelector('a'); if (la) { la.classList.add('active'); la.setAttribute('aria-selected', 'true'); } }
    _mppViewVisible = true;
    measureHeight();
    _refocusScanInput();
  }

  // Step aside when the operator clicks a native C7 tab (Angular shows that pane).
  function hideRoot() {
    const r  = document.getElementById('mpp-root');
    const li = document.getElementById('mpp-tab-li');
    if (r) { r.classList.remove('active'); r.style.display = 'none'; }
    if (li) { li.classList.remove('active'); const a = li.querySelector('a'); if (a) { a.classList.remove('active'); a.setAttribute('aria-selected', 'false'); } }
    _mppViewVisible = false;
  }

  function closeUI() {
    document.removeEventListener('keydown', onGlobalKey, true);
    window.removeEventListener('resize', measureHeight);
    // Restore the sidebar to its pre-open state — only undo classes we added.
    if (!_mppSidebarWasMin) document.body.classList.remove('sidebar-minimized');
    if (!_mppBrandWasMin)   document.body.classList.remove('brand-minimized');

    document.getElementById('mpp-tab-li')?.remove();
    document.getElementById('mpp-root')?.remove();

    // Restore exactly the tab + pane that were active before we opened.
    if (_prevActiveLi && document.contains(_prevActiveLi)) {
      _prevActiveLi.classList.add('active');
      const a = _prevActiveLi.querySelector('a.nav-link');
      if (a) { a.classList.add('active'); a.setAttribute('aria-selected', 'true'); }
    } else {
      const tabBar = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
      const lastLi = tabBar && Array.from(tabBar.querySelectorAll('li.nav-item')).pop();
      if (lastLi) { lastLi.classList.add('active'); const a = lastLi.querySelector('a.nav-link'); if (a) { a.classList.add('active'); a.setAttribute('aria-selected', 'true'); } }
    }
    if (_prevActivePanel && document.contains(_prevActivePanel)) {
      _prevActivePanel.classList.add('active');
      _prevActivePanel.style.display = '';
    } else {
      const tabContent = document.querySelector('div.tab-content');
      const panels = tabContent && Array.from(tabContent.querySelectorAll(':scope > tab, :scope > .tab-pane'));
      if (panels && panels.length) { const last = panels[panels.length - 1]; last.classList.add('active'); last.style.display = ''; }
    }
    _prevActiveLi = null; _prevActivePanel = null;
    _mppViewVisible = false;
    resetAll();
  }

  function onGlobalKey(e) {
    if (!document.getElementById('mpp-root')) return;
    if (e.key === 'Escape') { e.preventDefault(); confirmClose(); }
  }

  function confirmClose() {
    // Don't lose in-progress scans silently
    const hasWork = State.screen === 'SCAN' &&
      ([...Cache.items.values()].some(i => i.scannedBase > 0) || Cache.containers.length);
    if (hasWork && !confirm('Close Pallet Pack? Scanned (uncommitted) progress will be lost.')) return;
    closeUI();
  }

  function header(title, subtitle) {
    return `
      <div class="mpp-header">
        <div>
          <div class="mpp-title">${_esc(title)}</div>
          ${subtitle ? `<div class="mpp-subtitle">${subtitle}</div>` : ''}
        </div>
        <button class="mpp-x" id="mpp-close-btn" title="Close (Esc)">✕</button>
      </div>`;
  }
  function wireHeader() {
    document.getElementById('mpp-close-btn')?.addEventListener('click', confirmClose);
  }

  // ---- Screen 1: Profile select (guide §6) ----------------------------------
  function renderProfileSelect(msg) {
    State.screen = 'PROFILE';
    const r = root(); if (!r) return;
    const opts = State.profiles.map(p =>
      `<option value="${p.id}">${_esc(p.name || ('Profile ' + p.id))}</option>`).join('');
    r.innerHTML = `
      ${header('Pallet Pack', 'Select packing profile')}
      <div class="mpp-body">
        ${msg ? `<div class="mpp-note">${_esc(msg)}</div>` : ''}
        <label class="mpp-label">Packing profile</label>
        <select id="mpp-profile-sel" class="mpp-select">${opts || '<option>Loading…</option>'}</select>
        <button id="mpp-profile-go" class="mpp-btn mpp-btn-primary mpp-btn-lg" ${State.profiles.length ? '' : 'disabled'}>Continue</button>
      </div>`;
    wireHeader();
    if (State.profile) {
      const sel = document.getElementById('mpp-profile-sel');
      if (sel) sel.value = String(State.profile.id);
    }
    document.getElementById('mpp-profile-go')?.addEventListener('click', () => {
      const id = document.getElementById('mpp-profile-sel')?.value;
      const prof = State.profiles.find(p => String(p.id) === String(id));
      if (!prof) return;
      State.profile = prof;
      LOG('profile selected:', prof.id, prof.name, 'onlyRef:', profileOnlyAcceptsReference());
      Cache.reset();
      renderShipmentEntry();
    });
  }

  // ---- Screen 2: Shipment entry (guide §7) ----------------------------------
  function renderShipmentEntry(msg, msgType) {
    State.screen = 'SHIPMENT_ENTRY';
    const r = root(); if (!r) return;
    r.innerHTML = `
      ${header('Pallet Pack', 'Profile: ' + _esc(State.profile?.name || State.profile?.id))}
      <div class="mpp-body">
        <label class="mpp-label">Scan shipment number</label>
        <input id="mpp-ship-in" class="mpp-input mpp-scan" type="text" inputmode="none"
               autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
               placeholder="Scan / type shipment #" />
        <div id="mpp-ship-fb" class="mpp-fb ${msgType || 'dim'}">${_esc(msg || 'Ready to scan shipment')}</div>
        <button id="mpp-ship-back" class="mpp-btn mpp-btn-ghost">← Change profile</button>
      </div>`;
    wireHeader();
    const inp = document.getElementById('mpp-ship-in');
    inp?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        const v = inp.value.trim();
        inp.value = '';
        if (v) onShipmentScan(v);
      }
    });
    document.getElementById('mpp-ship-back')?.addEventListener('click', renderProfileSelect);
    setTimeout(() => inp?.focus(), 80);
  }

  async function onShipmentScan(shipmentNumber) {
    setShipFeedback('Loading…', 'dim');
    try {
      await loadShipment(shipmentNumber);
      Audio.chime('ok');
      renderScanScreen();
    } catch (err) {
      if (err.message === 'Session expired') return;
      Audio.chime('error');
      Voice.error(err.code === 'NOT_FOUND' ? 'Shipment not found' : 'Cannot load shipment');
      setShipFeedback(err.message || 'Could not load shipment', 'err');
      setTimeout(() => document.getElementById('mpp-ship-in')?.focus(), 60);
    }
  }
  function setShipFeedback(msg, type) {
    const el = document.getElementById('mpp-ship-fb');
    if (el) { el.textContent = msg; el.className = 'mpp-fb ' + (type || 'dim'); }
  }

  // ---- Screen 3: Blind scan (guide §10) -------------------------------------
  function renderScanScreen() {
    State.screen = 'SCAN';
    if (!Cache.current) Cache.current = newContainer(1);
    const r = root(); if (!r) return;
    r.innerHTML = `
      ${header('Pallet Pack', 'Shipment: ' + _esc(Cache.shipmentNumber))}
      <div class="mpp-body mpp-scan-body">
        <div class="mpp-container-badge" id="mpp-container-badge">Container ${Cache.containers.length + 1}</div>
        <div class="mpp-scan-zone" id="mpp-scan-zone">
          <div class="mpp-scan-zone-label">Scan items</div>
          <div class="mpp-scan-arrows">&gt;&gt;&gt;</div>
          <input id="mpp-scan-in" class="mpp-scan" type="text" inputmode="none"
                 autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="mpp-scan-meta" id="mpp-scan-meta"></div>
        <div class="mpp-scan-actions">
          <button id="mpp-view-btn" class="mpp-btn mpp-btn-ghost">View scanned</button>
          <button id="mpp-close-container-btn" class="mpp-btn mpp-btn-secondary">Close Container</button>
          <button id="mpp-finish-btn" class="mpp-btn mpp-btn-primary">Finish Verification</button>
        </div>
      </div>`;
    wireHeader();
    const inp = document.getElementById('mpp-scan-in');
    inp?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        const v = inp.value.trim();
        inp.value = '';
        if (v) onScan(v);
      }
    });
    document.getElementById('mpp-view-btn')?.addEventListener('click', showViewScanned);
    document.getElementById('mpp-close-container-btn')?.addEventListener('click', () => openCloseContainer(false));
    document.getElementById('mpp-finish-btn')?.addEventListener('click', onFinish);
    // Refocus scan input on any tap that isn't a button
    document.querySelector('.mpp-scan-body')?.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      setTimeout(() => document.getElementById('mpp-scan-in')?.focus(), 40);
    });
    updateScanScreenMeta();
    setTimeout(() => inp?.focus(), 80);
  }

  // Blind meta — shows ONLY how many scans landed in the current box + boxes closed.
  // No required items, counts, or progress (guide decision #4).
  function updateScanScreenMeta() {
    const el = document.getElementById('mpp-scan-meta');
    if (!el) return;
    let curUnits = 0;
    for (const v of Cache.current.lines.values()) curUnits += v;
    el.innerHTML =
      `<span class="mpp-meta-pill">This box: ${curUnits} unit${curUnits === 1 ? '' : 's'}</span>` +
      `<span class="mpp-meta-pill">Boxes closed: ${Cache.containers.length}</span>`;
    const badge = document.getElementById('mpp-container-badge');
    if (badge) badge.textContent = `Container ${Cache.containers.length + 1}`;
  }

  function flashScan() {
    const zone = document.getElementById('mpp-scan-zone');
    if (!zone) return;
    zone.classList.remove('mpp-flash');
    void zone.offsetWidth;
    zone.classList.add('mpp-flash');
  }

  // ---- View scanned modal (guide §10, decision #6) --------------------------
  function showViewScanned() {
    const r = root(); if (!r) return;
    const rows = [];
    for (const [id, it] of Cache.items) {
      if (it.scannedBase > 0) rows.push(itemScanRow(id, it));
    }
    const unexpectedRows = [...Cache.unexpected.entries()].map(([code, n]) =>
      `<div class="mpp-vs-row mpp-vs-bad"><span>${_esc(code)}</span><span>×${n} (unexpected)</span></div>`);
    const modal = document.createElement('div');
    modal.className = 'mpp-overlay';
    modal.innerHTML = `
      <div class="mpp-modal">
        <div class="mpp-modal-title">Scanned so far</div>
        <div class="mpp-vs-list">
          ${rows.length ? rows.join('') : '<div class="mpp-note">Nothing scanned yet.</div>'}
          ${unexpectedRows.join('')}
        </div>
        <button class="mpp-btn mpp-btn-primary" id="mpp-vs-close">Close</button>
      </div>`;
    r.appendChild(modal);
    document.getElementById('mpp-vs-close')?.addEventListener('click', () => {
      modal.remove();
      setTimeout(() => document.getElementById('mpp-scan-in')?.focus(), 40);
    });
  }
  function itemScanRow(id, it) {
    // Friendly UOM breakdown when an outer factor exists (guide §10)
    const breakdown = uomBreakdown(id, it.scannedBase);
    return `<div class="mpp-vs-row">
        <span><b>${_esc(it.itemCode)}</b> ${_esc(it.description)}</span>
        <span>${it.scannedBase}${breakdown ? ` (${breakdown})` : ''}</span>
      </div>`;
  }
  function uomBreakdown(itemId, base) {
    // Find the largest outer factor for this item from barcodeIndex
    let maxFactor = 1;
    for (const v of Cache.barcodeIndex.values()) {
      if (v.itemId === itemId && v.factor > maxFactor) maxFactor = v.factor;
    }
    if (maxFactor <= 1 || base < maxFactor) return '';
    const outers = Math.floor(base / maxFactor);
    const eaches = base % maxFactor;
    const parts = [];
    if (outers) parts.push(`${outers}×${maxFactor}`);
    if (eaches) parts.push(`${eaches}×1`);
    return parts.join(' + ');
  }

  // ===========================================================================
  // 10. CLOSE CONTAINER  (guide §10 — local only; number→type→weight/dims)
  // ===========================================================================

  // finishAfter: when true, this is the implicit close of the last (open) container
  // triggered by Finish (guide §11/§15) — after closing we proceed to the match.
  function openCloseContainer(finishAfter) {
    // Nothing scanned into the current box? Don't create an empty container.
    let curUnits = 0;
    for (const v of Cache.current.lines.values()) curUnits += v;
    if (curUnits === 0) {
      if (finishAfter) { doFinish(); return; }
      toast('Nothing scanned into this container yet.');
      return;
    }
    const suggestedWeight = suggestedWeightForCurrent();
    const r = root(); if (!r) return;
    const modal = document.createElement('div');
    modal.className = 'mpp-overlay';
    modal.innerHTML = `
      <div class="mpp-modal">
        <div class="mpp-modal-title">Close Container ${Cache.containers.length + 1}</div>
        <label class="mpp-label">Container number</label>
        <input id="mpp-cc-no" class="mpp-input" type="text" autocomplete="off"
               placeholder="Scan / type tote or box label" />
        <div id="mpp-cc-type" class="mpp-fb dim"></div>
        <div id="mpp-cc-type-picker-wrap" style="display:none">
          <label class="mpp-label">Container type</label>
          <select id="mpp-cc-type-picker" class="mpp-select"></select>
        </div>
        <div class="mpp-grid2">
          <div><label class="mpp-label">Weight (kg)</label>
            <input id="mpp-cc-wt" class="mpp-input" type="number" step="0.01" min="0" value="${suggestedWeight || ''}" /></div>
          <div><label class="mpp-label">Length (cm)</label>
            <input id="mpp-cc-l" class="mpp-input" type="number" step="0.1" min="0" /></div>
          <div><label class="mpp-label">Width (cm)</label>
            <input id="mpp-cc-w" class="mpp-input" type="number" step="0.1" min="0" /></div>
          <div><label class="mpp-label">Height (cm)</label>
            <input id="mpp-cc-h" class="mpp-input" type="number" step="0.1" min="0" /></div>
        </div>
        <div id="mpp-cc-fb" class="mpp-fb err" style="display:none"></div>
        <div class="mpp-grid2">
          <button id="mpp-cc-cancel" class="mpp-btn mpp-btn-ghost">Cancel</button>
          <button id="mpp-cc-ok" class="mpp-btn mpp-btn-primary">${finishAfter ? 'Close & Finish' : 'Close Container'}</button>
        </div>
      </div>`;
    r.appendChild(modal);

    const noIn = document.getElementById('mpp-cc-no');
    const typeFb = document.getElementById('mpp-cc-type');
    const pickerWrap = document.getElementById('mpp-cc-type-picker-wrap');
    const picker = document.getElementById('mpp-cc-type-picker');

    const refreshType = () => {
      const match = containerTypeFromNumber(noIn.value);
      if (match) {
        typeFb.textContent = `Type: ${match.name}`;
        typeFb.className = 'mpp-fb ok';
        pickerWrap.style.display = 'none';
      } else if (noIn.value.trim()) {
        // No prefix matched — prompt operator to pick a type (guide decision #8)
        typeFb.textContent = 'Unknown prefix — select a container type:';
        typeFb.className = 'mpp-fb err';
        if (!picker.options.length) {
          picker.innerHTML = State.containerTypes
            .map(ct => `<option value="${ct.id}">${_esc(ct.name || ct.description || ('Type ' + ct.id))}</option>`).join('');
        }
        pickerWrap.style.display = '';
      } else {
        typeFb.textContent = '';
        pickerWrap.style.display = 'none';
      }
    };
    noIn.addEventListener('input', refreshType);
    noIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); refreshType(); document.getElementById('mpp-cc-wt')?.focus(); } });

    document.getElementById('mpp-cc-cancel')?.addEventListener('click', () => {
      modal.remove();
      setTimeout(() => document.getElementById('mpp-scan-in')?.focus(), 40);
    });

    document.getElementById('mpp-cc-ok')?.addEventListener('click', () => {
      const fb = document.getElementById('mpp-cc-fb');
      const showErr = (m) => { fb.textContent = m; fb.style.display = ''; };
      const no = noIn.value.trim();
      if (!no) return showErr('Enter or scan the container number.');
      const match = containerTypeFromNumber(no);
      let typeId = match?.typeId;
      if (!typeId) {
        typeId = Number(picker.value);
        if (!typeId) return showErr('Select a container type.');
      }
      const weight = num(document.getElementById('mpp-cc-wt').value);
      const length = num(document.getElementById('mpp-cc-l').value);
      const width  = num(document.getElementById('mpp-cc-w').value);
      const height = num(document.getElementById('mpp-cc-h').value);
      // Honour wholesale profile confirm_weight / confirm_dimensions (guide §1.9)
      if (State.profile?.confirm_weight && weight <= 0) return showErr('Enter the container weight.');
      if (State.profile?.confirm_dimensions && (length <= 0 || width <= 0 || height <= 0))
        return showErr('Enter length, width and height.');

      // Finalise current into containers, start a fresh one (guide §10)
      Cache.current.containerNo = no;
      Cache.current.containerTypeId = typeId;
      Cache.current.weight = weight;
      Cache.current.length = length;
      Cache.current.width = width;
      Cache.current.height = height;
      Cache.containers.push(Cache.current);
      Cache.current = newContainer(Cache.containers.length + 1);

      modal.remove();
      Audio.chime('ok');
      updateScanScreenMeta();
      if (finishAfter) doFinish();
      else setTimeout(() => document.getElementById('mpp-scan-in')?.focus(), 40);
    });

    setTimeout(() => noIn?.focus(), 80);
  }

  function suggestedWeightForCurrent() {
    let w = 0;
    for (const [id, base] of Cache.current.lines) {
      const it = Cache.items.get(id);
      if (it && it.unitWeight) w += it.unitWeight * base;
    }
    return w > 0 ? Math.round(w * 100) / 100 : '';
  }

  // ===========================================================================
  // 11. FINISH VERIFICATION (local match, guide §11) + mismatch reset (§13)
  // ===========================================================================

  function onFinish() {
    if (State.committing) return;                 // re-entry guard (guide §15)
    // If the current box has scans, treat it as the final container: prompt its
    // weight/dims first, then finish (guide §11/§15).
    let curUnits = 0;
    for (const v of Cache.current.lines.values()) curUnits += v;
    if (curUnits > 0) { openCloseContainer(true); return; }
    doFinish();
  }

  function doFinish() {
    if (State.committing) return;
    if (!Cache.containers.length) { toast('Close at least one container first.'); return; }

    const mismatches = [];
    for (const it of Cache.items.values()) {
      if (it.scannedBase !== it.requiredBase) {
        mismatches.push({ itemCode: it.itemCode, required: it.requiredBase, scanned: it.scannedBase });
      }
    }
    const unexpected = [...Cache.unexpected.entries()];
    const verified = mismatches.length === 0 && unexpected.length === 0;

    if (verified) { commit(); }
    else { showMismatch(mismatches, unexpected); }
  }

  function showMismatch(mismatches, unexpected) {
    Audio.chime('error');
    Voice.error('Verification failed');
    vibrate([60, 30, 60]);
    const r = root(); if (!r) return;
    const rows = mismatches.map(m =>
      `<div class="mpp-vs-row mpp-vs-bad"><span><b>${_esc(m.itemCode)}</b></span><span>required ${m.required}, scanned ${m.scanned}</span></div>`);
    const un = unexpected.map(([code, n]) =>
      `<div class="mpp-vs-row mpp-vs-bad"><span>${_esc(code)}</span><span>unexpected ×${n}</span></div>`);
    const modal = document.createElement('div');
    modal.className = 'mpp-overlay';
    modal.innerHTML = `
      <div class="mpp-modal">
        <div class="mpp-modal-title" style="color:var(--c7-red)">✕ Verification failed</div>
        <div class="mpp-note">Differences (nothing has been committed):</div>
        <div class="mpp-vs-list">${rows.join('')}${un.join('')}</div>
        <button class="mpp-btn mpp-btn-primary" id="mpp-mm-ok">Reset &amp; rescan</button>
      </div>`;
    r.appendChild(modal);
    document.getElementById('mpp-mm-ok')?.addEventListener('click', () => {
      modal.remove();
      Cache.resetScans();               // keep items + barcodeIndex (guide §13)
      renderScanScreen();
    });
  }

  // ===========================================================================
  // 12. COMMIT  (deferred; runs only when verified — guide §12/§14)
  // ===========================================================================

  async function commit() {
    if (State.committing) return;
    State.committing = true;
    State.screen = 'COMMITTING';
    renderCommitting('Resolving packing context…');

    try {
      // 1. Resolve live packing context (guide §3 D4 two-step)
      const listPath =
        `shipment/shipment-container&shipment_number=${encShip(Cache.shipmentNumber)}` +
        `&expand=status,container_type&fields=id,container_no,status.id,container_type.name` +
        `&per-page=50&page=1`;
      const listRaw = await apiGet(listPath);
      const list = Array.isArray(listRaw) ? listRaw : (listRaw?.items || []);
      const source = list.find(c => Number(c.status?.id ?? c.status_id) === 5);
      if (!source) throw new Error('Source tote (status 5) not found for this shipment.');

      renderCommitting('Loading source tote…');
      const gpcRaw = await apiGet(
        `shipment/shipment-container/get-pack-container` +
        `&container_no=${encodeURIComponent(source.container_no)}&item_code=null` +
        `&profile=${State.profile.id}&expand=${PP_GPC_EXPAND}`
      );
      const gpcContainers = Array.isArray(gpcRaw) ? gpcRaw : [gpcRaw];
      // get-pack-container returns EVERY container on the shipment, not just the tote
      // we asked for — including already-packed (status-7) pieces from earlier boxes.
      // Only the source tote (the status-5 container we resolved) holds children still
      // to pack; using the others moved already-closed children and corrupted the close.
      const src = gpcContainers.find(c =>
        String(c.container_no) === String(source.container_no)) || gpcContainers[0] || {};
      const consignmentId    = src.consignment_id;
      const jobInstructionId = src.job_instruction_id;

      // Build remaining[item_id] = [ {childId, qtyBase, uomId} ] from the SOURCE tote's
      // still-open children only (guide §8/§12).
      // NOTE: C7 stores shipmentDetailChild.quantity in BASE units regardless of the
      // child's UOM (confirmed from a pack HAR: a Carton-UOM child of 25 + siblings
      // 11 + 30 summed to the detail's base qty of 66). Likewise pack-short-v2's
      // short_quantity is base units. So we do NOT multiply by the UOM factor here —
      // doing so previously inflated Carton children ×factor and left units unpacked.
      const remaining = new Map();
      for (const child of (src.shipmentDetailChildren || [])) {
        if (Number(child.status_id) === 7) continue;          // already packed — never touch
        const item = child.shipmentDetail?.item || {};
        const itemId = item.id ?? item.item_code;
        if (itemId == null) continue;
        const uomId = child.item_unit_of_measure_id ?? child.itemUnitOfMeasure?.id;
        if (!remaining.has(itemId)) remaining.set(itemId, []);
        remaining.get(itemId).push({ childId: child.id, uomId, qtyBase: num(child.quantity) });
      }

      // 2. Location constant (guide §3 D5)
      const loc = PACK_LOCATION_ID;

      // Container-number generator for boxes without an operator-supplied number
      let genSeq = 1;
      const genNumber = () => `${source.container_no}-${genSeq++}`;

      // 3. Per container, in order: create → move/pack children → close.
      //    SERIALISED per container (create → its moves/packs → close) because
      //    child-split ids chain (guide §12).
      let ci = 0;
      for (const cont of Cache.containers) {
        ci++;
        renderCommitting(`Packing container ${ci} of ${Cache.containers.length}…`);

        // a. create (regenerate number + retry on duplicate 500, guide §14).
        // Direct call (NOT via the retrying queue): a duplicate-number 500 is not
        // transient — retrying the same number always 500s, so we regenerate here.
        let containerNo = cont.containerNo || genNumber();
        let created = null;
        for (let attempt = 0; attempt < 10 && !created; attempt++) {
          try {
            created = await apiPost('shipment/shipment-container/create', {
              container_no: containerNo,
              status_id: 5,
              shipment_header_id: Cache.shipmentHeaderId,
              consignment_id: consignmentId,
              to_container: 1,
              job_instruction_id: jobInstructionId ?? null,
              consolidation_dock_id: null,
              container_type_id: cont.containerTypeId,
              status: 0,
              allow_inter_warehouse_transfer: 0,
              restrict_twofactor: 0,
            });
          } catch (e) {
            if (e.message === 'Session expired') throw e;
            if (e.status === 500) { containerNo = genNumber(); continue; }  // duplicate no.
            throw e;
          }
        }
        if (!created || !created.id) throw new Error('Could not create container ' + containerNo);
        const containerId = created.id;

        // b. allocate each item's units in cont.lines against remaining children (guide §12.b)
        for (const [itemId, baseNeed] of cont.lines) {
          let need = baseNeed;
          const queue = remaining.get(itemId) || [];
          while (need > 0 && queue.length) {
            const child = queue[0];
            if (child.qtyBase <= need) {
              // whole remaining qty of this child goes into this container → move
              await qCall(`move-${child.childId}-${containerId}`, () =>
                apiGet(
                  `shipment/shipment-container/move-into-container-v2` +
                  `&shipment_detail_child_id=${child.childId}` +
                  `&container_id=${containerId}&into_location=${loc}` +
                  `&custom_field_1=null&custom_field_2=null&profile_id=${State.profile.id}`
                ));
              need -= child.qtyBase;
              queue.shift();
            } else {
              // only part of this child goes into this container → pack-short-v2.
              // short_quantity is in BASE units (same units as child.quantity —
              // confirmed from the pack HAR: short_quantity=6 packed 6 and left a
              // remainder child of 19, i.e. 25-6). short_quantity = the amount packed
              // INTO this container; the returned NEW child carries the remainder
              // (which stays in the source tote) for the next container.
              const partBase = need;
              const resp = await qCall(`packshort-${child.childId}-${containerId}`, () =>
                apiGet(
                  `shipment/shipment-container/pack-short-v2` +
                  `&into_location=${loc}&shipment_detail_child_id=${child.childId}` +
                  `&short_quantity=${partBase}&container_id=${containerId}` +
                  `&custom_field_1=null&custom_field_2=null&profile_id=${State.profile.id}`
                ));
              const newChildId = resp?.id || resp?.child_id ||
                resp?.shipmentDetailChild?.id || resp?.shipment_detail_child?.id;
              // Remainder continues under the new child id for later containers
              child.qtyBase = Math.max(0, child.qtyBase - partBase);
              if (newChildId) child.childId = newChildId;
              need = 0;
            }
          }
          if (need > 0) WARN(`Container ${ci}: ${need} base units of item ${itemId} had no matching child.`);
        }

        // c. close — 500 is a soft warning (C7 closes before print side effects, guide §2.4)
        await closeToContainer(containerId, loc, cont);
      }

      // 4. Verify the shipment actually advanced before declaring success. C7 moves
      //    the shipment to Consigning Pending (7) as a side effect of all children
      //    being packed into closed containers — but a close can soft-fail server-side
      //    (e.g. "statusFlow on null") and leave it at Pack Pending. Don't show a false
      //    ✓ in that case (guide §2.2/§12). Do NOT call create-consignment-pieces.
      renderCommitting('Verifying shipment status…');
      const advanced = await verifyConsigningPending();
      if (advanced) {
        LOG('Commit complete — shipment at Consigning Pending. No consign call fired.');
        renderSuccess();
      } else {
        WARN('Commit ran but shipment is still Pack Pending — a container may not have closed.');
        renderCommitError(new Error(
          'Packing didn’t complete — the shipment is still Pack Pending (a container may have failed to close). ' +
          'Nothing was consigned; check C7 and retry.'));
      }
    } catch (err) {
      if (err.message === 'Session expired') return;   // overlay already shown
      WARN('commit failed:', err.message);
      renderCommitError(err);
    }
  }

  // Re-fetch the shipment header status; true once it reaches Consigning Pending (7).
  async function verifyConsigningPending() {
    try {
      const data = await apiGet(
        `shipment/shipment-detail&shipment_number=${encShip(Cache.shipmentNumber)}` +
        `&expand=shipmentHeader&fields=id,shipment_header.id,shipment_header.leading_status_id` +
        `&per-page=1&page=1`
      );
      const rows = Array.isArray(data) ? data : (data?.items || []);
      const h = rows[0]?.shipmentHeader || rows[0]?.shipment_header || {};
      const st = Number(h.leading_status_id);
      LOG('post-commit leading status:', st);
      return st === 7;
    } catch (e) {
      WARN('status verify failed:', e.message);
      return false;   // can't confirm → treat as not-advanced (honest, retryable)
    }
  }

  // close-to-container with Pack's soft-500 handling (guide §2.4). Returns even
  // on 500 (container is closed server-side before print/label side effects).
  async function closeToContainer(containerId, loc, cont) {
    await waitForSession();
    const url = API_BASE +
      `shipment/shipment-container/close-to-container` +
      `&close_to_location_id=${loc}&container_id=${containerId}` +
      `&profile_id=${State.profile.id}` +
      `&weight=${num(cont.weight)}&length=${num(cont.length)}` +
      `&width=${num(cont.width)}&height=${num(cont.height)}`;
    const res = await fetch(url, { method: 'GET', headers: mkHeaders() });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { _showSessionExpired(); throw new Error('Session expired'); }
    if (!res.ok) {
      // Any non-2xx other than 401 is treated as soft — the container is closed
      // server-side; only post-close side effects (labels/print) failed.
      WARN('close-to-container soft error:', res.status, body.message || '');
      return { id: containerId, status_id: 7, _softError: body.message || `Server error ${res.status}` };
    }
    return body;
  }

  // ---- Commit progress / success / error screens ----------------------------
  function renderCommitting(msg) {
    const r = root(); if (!r) return;
    r.innerHTML = `
      ${header('Pallet Pack', 'Committing…')}
      <div class="mpp-body mpp-center">
        <div class="mpp-spinner"></div>
        <div class="mpp-note" id="mpp-commit-msg">${_esc(msg || 'Working…')}</div>
      </div>`;
  }
  function updateCommitMsg(msg) { const el = document.getElementById('mpp-commit-msg'); if (el) el.textContent = msg; }

  function renderSuccess() {
    State.screen = 'SUCCESS';
    State.committing = false;
    Audio.chime('ok');
    Voice.speak('Verified and packed');
    const r = root(); if (!r) return;
    r.innerHTML = `
      ${header('Pallet Pack', 'Done')}
      <div class="mpp-body mpp-center">
        <div class="mpp-big-tick">✓</div>
        <div class="mpp-success-title">Verified &amp; packed</div>
        <div class="mpp-note">Shipment is now <b>Consigning Pending</b>.<br>Take it to the desk to consign.</div>
        <button id="mpp-next-btn" class="mpp-btn mpp-btn-primary mpp-btn-lg">Next shipment</button>
      </div>`;
    wireHeader();
    document.getElementById('mpp-next-btn')?.addEventListener('click', resetForNextShipment);
  }

  // Commit-time failure: keep ALL local state, offer retry (guide §13)
  function renderCommitError(err) {
    State.committing = false;
    Audio.chime('error');
    // Job-type / "null" errors on move/pack mean the shipment's picking job type
    // isn't valid for this profile — surface that, don't imply a transient fault. (guide §2.3/§15)
    let msg = err.message || 'Unknown error';
    if (/completePacking|packShortV2|\bnull\b|job.?type|not valid/i.test(msg)) {
      msg = "Shipment's job type may not be valid for this profile (or a child id was stale). Original error: " + msg;
    }
    err = { message: msg };
    const r = root(); if (!r) return;
    r.innerHTML = `
      ${header('Pallet Pack', 'Commit error')}
      <div class="mpp-body mpp-center">
        <div class="mpp-big-tick" style="color:var(--c7-red)">!</div>
        <div class="mpp-success-title" style="color:var(--c7-red)">Couldn't finish packing</div>
        <div class="mpp-note">${_esc(err.message || 'Unknown error')}</div>
        <div class="mpp-note">Nothing was reset. You can retry the commit.</div>
        <button id="mpp-retry-btn" class="mpp-btn mpp-btn-primary mpp-btn-lg">Retry commit</button>
        <button id="mpp-back-scan-btn" class="mpp-btn mpp-btn-ghost">Back to scan screen</button>
      </div>`;
    wireHeader();
    document.getElementById('mpp-retry-btn')?.addEventListener('click', () => commit());
    document.getElementById('mpp-back-scan-btn')?.addEventListener('click', () => { State.screen = 'SCAN'; renderScanScreen(); });
  }

  // ---- Toast ----------------------------------------------------------------
  function toast(msg) {
    const r = root(); if (!r) return;
    const t = document.createElement('div');
    t.className = 'mpp-toast';
    t.textContent = msg;
    r.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2200);
  }

  // ===========================================================================
  // 13. FOCUS RECOVERY  (copied from Pick §22 — three layers)
  // ===========================================================================

  function _refocusScanInput() {
    const inputId = _SCAN_SCREENS[State.screen];
    if (!inputId) return;
    if (root()?.querySelector('.mpp-overlay')) return;   // a modal is open
    const el = document.getElementById(inputId);
    if (!el || !document.contains(el)) return;
    if (document.activeElement === el) return;
    el.focus();
  }
  // A. Page becomes visible (screen wake / app foreground)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(_refocusScanInput, 300);
  });
  // B. Window regains focus
  window.addEventListener('focus', () => setTimeout(_refocusScanInput, 200));
  // C. Periodic poll every 2.5s — catches anything A/B missed
  setInterval(() => { if (document.getElementById('mpp-root')) _refocusScanInput(); }, 2500);

  // ===========================================================================
  // 14. NAV INJECTION  (copied from Pick §4 — adds a "Pallet Pack" nav item)
  // ===========================================================================

  let _navClickAttached = false;
  function attachNavClickListener() {
    if (_navClickAttached) return;
    _navClickAttached = true;
    document.addEventListener('click', (e) => {
      // Our sidebar launcher → open / re-show.
      const nav = document.getElementById('mpp-nav');
      if (nav && (nav === e.target || nav.contains(e.target))) { e.preventDefault(); openUI(); return; }

      // While our view is open, clicking any OTHER C7 tab or sidebar nav link should
      // hide our view (C7 is switching to its own content) — same behaviour as Pack.
      if (!document.getElementById('mpp-root') || !_mppViewVisible) return;
      if (e.target.closest('#mpp-tab-li')) return;                       // our own tab — handled there
      const otherTab = e.target.closest('ul.nav.nav-tabs[role="tablist"] li.nav-item');
      const sideNav  = e.target.closest('div.sidebar a.nav-link, .sidebar a.nav-link, div.sidebar li.nav-item');
      if (otherTab || sideNav) hideRoot();
    }, true);
  }

  let _prefetched = false;
  function injectNav() {
    attachNavClickListener();
    if (document.getElementById('mpp-nav')) return;
    const ul = document.querySelector('div.sidebar nav ul.nav');
    if (!ul) return;

    const li = document.createElement('li');
    li.id = 'mpp-nav-li';
    li.className = 'nav-item ng-star-inserted';

    const a = document.createElement('a');
    a.id = 'mpp-nav';
    a.className = 'nav-link ng-star-inserted';
    a.setAttribute('href', 'javascript:void(0)');
    // Compact inline-SVG box icon (no external URL dependency)
    a.innerHTML =
      `<span class="mpp-nav-icon" style="display:inline-flex;width:20px;height:20px;margin-right:8px;vertical-align:middle">` +
      `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>` +
      `<polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></span>` +
      `<span class="mpp-nav-label">Pallet Pack</span>`;

    li.appendChild(a);
    ul.insertBefore(li, ul.firstChild);

    if (!_prefetched) { _prefetched = true; setTimeout(() => initData(), 600); }
  }

  // ===========================================================================
  // 15. CSS
  // ===========================================================================

  function injectCSS() {
    if (document.getElementById('mpp-styles')) return;
    const style = document.createElement('style');
    style.id = 'mpp-styles';
    style.textContent = `
      /* Canary7-matched design tokens (same palette as Malpa Pack v3) — scoped to
         our root so we never touch C7's own :root variables.
         The root is now a native .tab-pane inside div.tab-content (like Malpa Pick),
         so it flows/fills automatically — position:relative, height set by JS. */
      .mpp-root{
        --c7-bg:#eef1f5; --c7-surf:#ffffff; --c7-surf2:#f9f9fa; --c7-surf3:#eef9fd;
        --c7-border:#e1e6ef; --c7-border2:#c0cadd; --c7-text:#394967;
        --c7-muted:#9faecb; --c7-muted2:#6b7280; --c7-teal:#2ea8d6; --c7-amber:#fabb3d;
        --c7-green:#79c447; --c7-green-bg:#eff9eb; --c7-green-bd:#bde5ae; --c7-red:#ff5454;
        --c7-font:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;
        --c7-mono:'SF Mono','Fira Code',Consolas,monospace; --c7-r:4px;
        position:relative; height:calc(100vh - 55px); max-height:100vh;
        background:var(--c7-surf2); color:var(--c7-text);
        font-family:var(--c7-font); display:flex; flex-direction:column; overflow:hidden;
        animation:mpp-in .12s ease;
      }
      @keyframes mpp-in{from{opacity:0}to{opacity:1}}
      /* ── titlebar (C7 tab look) ── */
      .mpp-header{display:flex;align-items:center;justify-content:space-between;
        background:var(--c7-surf);border-bottom:1px solid var(--c7-border);
        min-height:44px;padding:6px 12px 6px 16px;flex-shrink:0;
        box-shadow:inset 0 -2px 0 var(--mp-brand,#6fc3eb)}
      .mpp-header>div:first-child{min-width:0;flex:1}
      .mpp-title{font-size:17px;font-weight:600;color:var(--c7-text)}
      .mpp-subtitle{font-size:13px;color:var(--c7-muted);margin-top:2px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mpp-x{background:none;border:none;color:var(--c7-muted2);font-size:20px;cursor:pointer;
        padding:2px 6px;border-radius:3px;line-height:1;transition:color .1s,background .1s}
      .mpp-x:hover{color:var(--c7-text);background:var(--c7-surf3)}
      /* ── body ── */
      .mpp-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:14px;background:var(--c7-surf)}
      .mpp-body::-webkit-scrollbar{width:6px}
      .mpp-body::-webkit-scrollbar-thumb{background:var(--c7-border2);border-radius:3px}
      .mpp-center{align-items:center;justify-content:center;text-align:center}
      /* ── labels / inputs / selects ── */
      .mpp-label{font-size:15px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
        color:var(--c7-text);display:block;margin-bottom:4px}
      .mpp-input,.mpp-select{width:100%;box-sizing:border-box;background:var(--c7-bg);
        border:1px solid var(--c7-border2);border-radius:var(--c7-r);color:var(--c7-text);
        font-family:var(--c7-font);font-size:22px;padding:14px 16px;min-height:54px;outline:none;
        transition:border-color .12s}
      .mpp-input:focus,.mpp-select:focus{border-color:var(--c7-teal)}
      .mpp-input::placeholder{color:var(--c7-muted)}
      .mpp-select{font-size:18px}
      .mpp-grid2 .mpp-input{font-size:18px;padding:12px;min-height:48px}
      /* ── buttons ── */
      .mpp-btn{border:none;border-radius:var(--c7-r);cursor:pointer;font-family:var(--c7-font);
        font-weight:600;font-size:17px;padding:0 14px;min-height:54px;min-width:0;color:#fff;
        display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis;transition:background .1s,opacity .1s}
      .mpp-btn-lg{font-size:21px;min-height:58px}
      .mpp-btn-primary{background:var(--c7-teal)}
      .mpp-btn-primary:hover:not(:disabled){background:#1985ac}
      .mpp-btn-secondary{background:var(--c7-amber);color:#173140}
      .mpp-btn-secondary:hover:not(:disabled){background:#e9a92f}
      .mpp-btn-ghost{background:var(--c7-surf3);color:var(--c7-text);border:1px solid var(--c7-border2)}
      .mpp-btn-ghost:hover:not(:disabled){background:#e2f2fb}
      .mpp-btn:disabled{opacity:.4;cursor:not-allowed;pointer-events:none}
      /* ── notes / feedback ── */
      .mpp-note{font-size:15px;color:var(--c7-muted);line-height:1.5}
      .mpp-fb{font-size:15px;min-height:20px}
      .mpp-fb.ok{color:var(--c7-green)}.mpp-fb.err{color:var(--c7-red)}.mpp-fb.dim{color:var(--c7-muted)}
      .mpp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .mpp-grid2>*{min-width:0}
      /* ── scan screen ── */
      .mpp-scan-body{gap:16px}
      .mpp-container-badge{align-self:center;background:var(--c7-surf3);border:1px solid var(--c7-border);
        padding:8px 18px;border-radius:20px;font-weight:700;font-size:16px;color:var(--c7-teal)}
      .mpp-scan-zone{position:relative;border:2px dashed var(--c7-border2);border-radius:8px;
        padding:40px 16px;text-align:center;background:var(--c7-bg);transition:background .12s,border-color .12s}
      .mpp-scan-zone.mpp-flash{background:var(--c7-green-bg);border-color:var(--c7-green-bd)}
      .mpp-scan-zone-label{font-size:20px;font-weight:700;color:var(--c7-text)}
      .mpp-scan-arrows{font-size:28px;color:var(--c7-teal);letter-spacing:4px;margin-top:8px}
      .mpp-scan{position:absolute;opacity:0;left:0;top:0;width:1px;height:1px;border:0;padding:0}
      input.mpp-scan.mpp-input{position:static;opacity:1;width:100%;height:auto}
      .mpp-scan-meta{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
      .mpp-meta-pill{background:var(--c7-surf2);border:1px solid var(--c7-border);border-radius:16px;
        padding:8px 14px;font-size:14px;color:var(--c7-muted2)}
      .mpp-scan-actions{display:flex;flex-direction:column;gap:10px;margin-top:auto}
      /* ── overlay + modal (light) ── */
      .mpp-overlay{position:absolute;inset:0;z-index:10;background:rgba(57,73,103,.45);
        display:flex;align-items:center;justify-content:center;padding:16px}
      .mpp-modal{width:100%;max-width:440px;max-height:92%;overflow:hidden auto;background:var(--c7-surf);
        border:1px solid var(--c7-border2);border-radius:8px;padding:18px;box-sizing:border-box;
        display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 40px rgba(57,73,103,.25)}
      .mpp-modal-title{font-size:19px;font-weight:700;color:var(--c7-text)}
      .mpp-vs-list{display:flex;flex-direction:column;gap:6px;margin:2px 0}
      .mpp-vs-row{display:flex;justify-content:space-between;gap:10px;font-size:15px;
        padding:10px 12px;background:var(--c7-bg);border-radius:var(--c7-r);color:var(--c7-text)}
      .mpp-vs-bad{border-left:3px solid var(--c7-red);background:#fff3f3}
      /* ── success / error ── */
      .mpp-big-tick{font-size:64px;color:var(--c7-green);font-weight:700;line-height:1}
      .mpp-success-title{font-size:22px;font-weight:700;color:var(--c7-text)}
      .mpp-spinner{width:44px;height:44px;border:4px solid var(--c7-border);border-top-color:var(--c7-teal);
        border-radius:50%;animation:mpp-spin .8s linear infinite}
      @keyframes mpp-spin{to{transform:rotate(360deg)}}
      /* ── toast ── */
      .mpp-toast{position:absolute;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);
        background:var(--c7-text);color:#fff;padding:12px 18px;border-radius:8px;font-size:15px;
        opacity:0;transition:.25s;z-index:20;max-width:90%;box-shadow:0 8px 24px rgba(0,0,0,.25)}
      .mpp-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
      #mpp-nav .mpp-nav-label{vertical-align:middle}
      /* Tab chip injected into C7's tab bar — inherits C7 tab styling from
         .nav-item/.nav-link; these rules only style our label + close control. */
      #mpp-tab-li .mpp-tab-label{vertical-align:middle}
      #mpp-tab-li .mpp-tab-x{margin-left:10px;font-size:16px;line-height:1;opacity:.65;
        cursor:pointer;padding:0 2px;border-radius:3px}
      #mpp-tab-li .mpp-tab-x:hover{opacity:1;background:rgba(0,0,0,.08)}
    `;
    document.head.appendChild(style);
  }

  // ===========================================================================
  // 16. BOOT  (copied from Pick §9)
  // ===========================================================================

  captureSessionId();
  (async () => {
    for (let i = 0; i < 50 && !_sessionId; i++) {
      await new Promise(r => setTimeout(r, 100));
      captureSessionId();
    }
  })();

  let _attempts = 0;
  function tryInject() {
    if (document.querySelector('div.sidebar nav li.nav-item')) { injectNav(); return; }
    if (++_attempts < 80) setTimeout(tryInject, 500);
  }

  new MutationObserver(() => {
    if (!document.getElementById('mpp-nav') && document.querySelector('div.sidebar nav li.nav-item')) {
      injectNav();
    }
  }).observe(document.body, { childList: true, subtree: true });

  tryInject();

})();
