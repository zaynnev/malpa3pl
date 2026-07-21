// ==UserScript==
// @name         Malpa Pack v3
// @namespace    https://malpa.canary7.com
// @version      3.3.82
// @updateURL    https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-pack.user.js
// @downloadURL  https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-pack.user.js
// @description  High-throughput packing station for Canary7 WMS — optimistic scanning, async API queue, dynamic profiles
// @author       Malpa 3PL
// @match        https://*.canary7.com/*
// @grant        GM_xmlhttpRequest
// @connect      metrics.malpasoft.com
// @run-at       document-idle
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   UI Layer  ──→  State Store  ──→  Workflow Engine  ──→  Async API Queue
 *
 *  Key design principles:
 *  1. get-pack-container is called ONCE per source container.  Never again
 *     unless an explicit refresh is requested.
 *  2. Barcode matching happens 100 % client-side.  Scan feedback is instant.
 *  3. item-verification & move-into-container are fired asynchronously after
 *     the operator has already received visual success feedback.
 *  4. Failed async calls roll back local state and alert the operator.
 *  5. A single APIQueue with configurable concurrency and retry prevents
 *     duplicate in-flight requests for the same child ID.
 *  6. All packing profiles and pack-to locations are fetched dynamically;
 *     nothing is hard-coded except API_BASE and WAREHOUSE_ID.
 *  7. Multi-container shipments share a single ShipmentCache.  Closing one
 *     container does NOT clear remaining items; they roll automatically into
 *     the next container created for the same shipment.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // 0.  CONSTANTS
  // ─────────────────────────────────────────────────────────────────────────────

  const API_BASE     = 'https://stgauth.canary7.com/index.php?r=';
  const WAREHOUSE_ID = 10;

  // Trimmed to only fields actually used in the UI — removes 5 unused expands
  // reducing GPC payload size and server-side processing time.
  const GPC_EXPAND = [
    'shipmentHeader', 'jobInstruction', 'company',
    'shipmentDetailChildren.shipmentDetail.item.itemUnitOfMeasures.unitOfMeasure',
    'shipmentDetailChildren.shipmentDetail.item.itemUnitOfMeasures.itemUnitOfMeasureReference',
    'shipmentDetailChildren.shipmentDetail.item.itemWeights',
    'shipmentHeader.address',
    'shipmentHeader.carrier', 'shipmentHeader.carrierService',
  ].join(',');

  const RETAIN_TOTE_ENABLED_KEY = 'mp_retain_tote';
  const RETAIN_TOTE_NO_KEY      = 'mp_retained_tote_no';

  // Same expected-carton source as the standalone Pack Prompt script.
  // Card 581 maps shipment number → expected carton label, then we map that
  // label to a Canary7 container type for dimensions/scan confirmation.
  const PACK_PROMPT_LABELS_URL = 'https://metrics.malpasoft.com/api/card/581/query';
  const PACK_PROMPT_LABELS_API_KEY = 'mb_N5fatrQAS8lmgPylcQ/uRBe9OfC/cBj8zPzGQRf0H14=';

  const PERF = { enabled: true };

  function perfNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function perfMark(label, start, extra = '') {
    if (!PERF.enabled || !start) return;
    const ms = Math.round(perfNow() - start);
    console.log(`[MalpaPack][perf] ${label}: ${ms}ms${extra ? ` — ${extra}` : ''}`);
  }

  function normPackPromptValue(v) {
    return String(v || '').toLowerCase().replace(/\s+/g, '').trim();
  }

  const ExpectedCartonCache = {
    loaded: false,
    promise: null,
    byShipment: new Map(),

    load() {
      if (this.promise) return this.promise;
      this.promise = new Promise(resolve => {
        const finish = () => {
          this.loaded = true;
          resolve(this.byShipment);
        };
        const ingest = payload => {
          const rows = payload?.data?.rows || payload?.result?.data?.rows || payload?.rows || [];
          for (const r of rows || []) {
            const shipment = normPackPromptValue(r?.[0]);
            const label = r?.[1];
            if (shipment && label) this.byShipment.set(shipment, String(label));
          }
          console.log(`[MalpaPack] Cached ${this.byShipment.size} expected carton labels`);
        };

        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'POST',
            url: PACK_PROMPT_LABELS_URL,
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-API-Key': PACK_PROMPT_LABELS_API_KEY,
            },
            data: JSON.stringify({ parameters: [] }),
            timeout: 20000,
            onload: res => {
              try { ingest(res.responseText ? JSON.parse(res.responseText) : null); }
              catch (e) { console.warn('[MalpaPack] expected carton label load error:', e.message); }
              finish();
            },
            onerror: () => finish(),
            ontimeout: () => finish(),
          });
          return;
        }

        fetch(PACK_PROMPT_LABELS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-API-Key': PACK_PROMPT_LABELS_API_KEY,
          },
          body: JSON.stringify({ parameters: [] }),
        })
          .then(r => r.json())
          .then(ingest)
          .catch(err => console.warn('[MalpaPack] expected carton label load error:', err.message))
          .finally(finish);
      });
      return this.promise;
    },

    get(shipmentNumber) {
      return this.byShipment.get(normPackPromptValue(shipmentNumber)) || null;
    },
  };

  function loadToteInventoryDetailsInBackground(containerNo, { label = 'tote detail', fallbackContainers = null } = {}) {
    const sourceNo = String(containerNo || '').trim();
    if (!sourceNo) return Promise.resolve([]);

    // SIBP: the tote holds inventory for multiple shipments — GPC only shows the
    // current shipment's children. Call C7's inventory endpoint directly to get
    // the full tote picture. If operators lack permission it fails silently.
    if (Workflow.usesItemInitiatedFlow()) {
      return apiGet(`inventory/inventory&license_plate_no=${encodeURIComponent(sourceNo)}&expand=item&per-page=200&page=1`)
        .then(data => {
          const rows = Array.isArray(data) ? data : (data?.items || []);
          if (rows.length) {
            SourceToteCache.ingestFromInventory(sourceNo, rows);
            updateDetailCounter();
          }
          return rows;
        })
        .catch(err => {
          console.warn('[MalpaPack] SIBP inventory detail lookup failed:', err.message);
          return [];
        });
    }

    // Standard profiles: use GPC data already loaded into ShipmentCache.
    // Zero extra API calls — data is already in memory.
    const containers = fallbackContainers || (
      ShipmentCache.sourceContainerNo === sourceNo
        ? [{ shipmentDetailChildren: Object.values(ShipmentCache.items).map(t => t.child) }]
        : null
    );
    if (containers) {
      SourceToteCache.ingestFromGPC(sourceNo, containers);
      updateDetailCounter();
    }
    return Promise.resolve([]);
  }

  function getDetailsRemaining() {
    const tracks = (Workflow.usesRetainedSourceFlow() || Workflow.usesItemInitiatedFlow()) && SourceToteCache.allItems.length
      ? SourceToteCache.allItems
      : ShipmentCache.allItems;
    return tracks.reduce((sum, t) => sum + Math.max(0, (t.required || 0) - (t.scanned || 0)), 0);
  }

  function rememberRetainedTote(containerNo) {
    const no = String(containerNo || '').trim();
    if (!no) return;
    try { localStorage.setItem(RETAIN_TOTE_NO_KEY, no); } catch (_) {}
  }

  function clearRetainedToteNumber() {
    try { localStorage.removeItem(RETAIN_TOTE_NO_KEY); } catch (_) {}
    if (R?.toteIn) R.toteIn.value = '';
  }

  function resetRetainedToteState() {
    try { localStorage.setItem(RETAIN_TOTE_ENABLED_KEY, '0'); } catch (_) {}
    clearRetainedToteNumber();
    if (R?.retainChk) R.retainChk.checked = false;
    if (R?.toteIn) R.toteIn.value = '';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1.  AUTH
  // ─────────────────────────────────────────────────────────────────────────────

  function getToken() {
    for (const key of ['access_token', 'token', 'id_token', 'auth_token']) {
      const v = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (v && v.length > 20) return v;
    }
    return null;
  }

  /**
   * Read x-session-id from Canary7's Angular app state.
   * The Angular HttpInterceptor adds this to every API call — it links requests
   * to the user's active session which has printer/print-route assignments.
   * Without it, create-consignment-pieces returns "No Print Route".
   *
   * Strategy: intercept an outgoing XHR/fetch from the Angular app to capture
   * the header value once, then reuse it. Falls back to localStorage search.
   */
  let _sessionId = null;

  function captureSessionId() {
    if (_sessionId) return;

    // Search localStorage and sessionStorage for a numeric session/shift value
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          const val = store.getItem(key);
          if (key && (key.toLowerCase().includes('session') || key.toLowerCase().includes('shift'))
              && val && /^\d+$/.test(val.trim())) {
            _sessionId = val.trim();
            return;
          }
        }
      } catch (_) {}
    }

    // Intercept the next Angular XHR to steal x-session-id from its headers
    // by monkey-patching XMLHttpRequest.setRequestHeader once
    if (!window._mpXHRPatched) {
      window._mpXHRPatched = true;
      const origSet = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (name.toLowerCase() === 'x-session-id' && value && !_sessionId) {
          _sessionId = String(value);
                // Restore original after capture
          XMLHttpRequest.prototype.setRequestHeader = origSet;
          window._mpXHRPatched = false;
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

  /** Wait for x-session-id to be captured (up to 1s) before firing API calls */
  async function waitForSession() {
    if (_sessionId) return;
    captureSessionId();
    for (let i = 0; i < 10 && !_sessionId; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async function apiGet(path) {
    await waitForSession();
    const res = await fetch(API_BASE + path, { method: 'GET', headers: mkHeaders() });
    if (res.status === 401) throw new Error('Session expired — please log in again.');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`${body.message || `API error ${res.status}`} [${res.status}]`);
    }
    return res.json();
  }

  async function apiPost(path, data) {
    await waitForSession();
    const res = await fetch(API_BASE + path, {
      method: 'POST', headers: mkHeaders(), body: JSON.stringify(data),
    });
    if (res.status === 401) throw new Error('Session expired — please log in again.');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `API error ${res.status}`);
    }
    return res.json();
  }

  async function apiDelete(path) {
    await waitForSession();
    const res = await fetch(API_BASE + path, { method: 'DELETE', headers: mkHeaders() });
    if (res.status === 401) throw new Error('Session expired — please log in again.');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `API error ${res.status}`);
    }
    return res.json().catch(() => ({}));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2.  ASYNC API QUEUE
  //     Guarantees: concurrency cap, per-item dedup, exponential retry,
  //     clean rollback callback on failure.
  // ─────────────────────────────────────────────────────────────────────────────

  class APIQueue {
    constructor({ concurrency = 3, maxRetries = 3 } = {}) {
      this._concurrency = concurrency;
      this._maxRetries  = maxRetries;
      this._queue       = [];
      this._running     = 0;
      this._inFlight    = new Set(); // dedup keys
    }

    // Enqueue a task.  Returns a promise that resolves/rejects when done.
    enqueue({ key, fn, onSuccess, onFailure, priority = 0 }) {
      if (key && this._inFlight.has(key)) return Promise.resolve(null); // dedup
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
        // completePacking() on null means the child ID is stale/split — never retry.
        // packShortV2() on null means the same. Retrying will always fail.
        const isStaleChild = err.message && (
          err.message.includes('completePacking') ||
          err.message.includes('packShortV2')
        );
        task.attempt++;
        if (!isStaleChild && task.attempt < this._maxRetries) {
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

    drain() {
      return new Promise(resolve => {
        const check = () => (this._running === 0 && this._queue.length === 0)
          ? resolve() : setTimeout(check, 50);
        check();
      });
    }
  }

  const Q = new APIQueue({ concurrency: 4, maxRetries: 3 });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3.  STATE STORE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * ShipmentCache — persists across containers for the same shipment.
   * Keyed by shipment_header_id so closing container #1 doesn't wipe items
   * that will go into container #2.
   */
  const ShipmentCache = {
    shipmentHeaderId: null,
    sourceContainerNo: null,
    sourceContainerId: null,
    shipmentHeader: null,
    company: null,
    jobInstruction: null,
    /** map childId → ItemTrack */
    items: {},

    clear() {
      this.shipmentHeaderId  = null;
      this.sourceContainerNo = null;
      this.sourceContainerId = null;
      this.shipmentHeader    = null;
      this.company           = null;
      this.jobInstruction    = null;
      this.items             = {};
    },

    /** Load from get-pack-container response array */
    loadFromGPC(containers) {
      // Use the first container for header/meta — it is always the source tote
      const c = containers[0];
      this.shipmentHeaderId  = c.shipment_header_id;
      this.sourceContainerId = c.id;
      this.sourceContainerNo = c.container_no;
      this.shipmentHeader    = c.shipmentHeader || c.shipment_header;
      this.company           = c.company;
      this.jobInstruction    = c.jobInstruction;

      // Collect children from ALL containers in the response — Canary7 sometimes
      // returns [source_tote, outbound_container] and children may appear in either.
      for (const container of containers) {
        for (const child of container.shipmentDetailChildren || []) {
          if (!this.items[child.id]) {
            this.items[child.id] = new ItemTrack(child, container);
          }
        }
      }

      // Store total original quantity once — used as denominator for proportional
      // weight calculation across multi-piece shipments. Never mutated by split.
      this.totalOriginalQty = Object.values(this.items)
        .filter(t => (Number(t.required) || 0) > 0)
        .reduce((s, t) => s + t.required, 0);
    },

    get allItems() { return Object.values(this.items).filter(t => (Number(t.required) || 0) > 0); },
    get pendingItems() { return this.allItems.filter(t => !t.done); },
    get doneItems()    { return this.allItems.filter(t => t.done); },
    get total()        { return this.allItems.reduce((s, t) => s + t.required, 0); },
    get packed()       { return this.allItems.reduce((s, t) => s + t.scanned, 0); },
    get pct()          { return this.total > 0 ? Math.round(this.packed / this.total * 100) : 0; },
    get allDone()      { return this.pendingItems.length === 0; },
  };


  /**
   * SourceToteCache — SIBP-safe tote-level counter state.
   * ShipmentCache remains shipment-scoped because scan matching, close, and
   * pack-short must never operate on future shipments in the same tote.
   * This cache is only for the titlebar detail counter and retain behaviour.
   */
  const SourceToteCache = {
    sourceContainerNo: null,
    /** map childId → lightweight tote counter row */
    items: {},

    clear() {
      this.sourceContainerNo = null;
      this.items = {};
    },

    ensure(containerNo) {
      const no = String(containerNo || '').trim();
      if (!no) return;
      if (this.sourceContainerNo !== no) {
        this.sourceContainerNo = no;
        this.items = {};
      }
    },

    hasInventoryRows() {
      return Object.values(this.items || {}).some(row => row?.source === 'inventory');
    },

    ingestFromGPC(containerNo, containers) {
      this.ensure(containerNo);
      // SIBP uses a tote/SKU-level counter from the Retool inventory workflow.
      // Do not accumulate one GPC child row per shipment/item scan, because that
      // makes Details in Container grow every time the operator verifies another
      // pre-consigned SIBP shipment from the same source tote.
      if (Workflow.usesItemInitiatedFlow()) return;

      for (const container of containers || []) {
        for (const child of container.shipmentDetailChildren || []) {
          if (!this.items[child.id]) {
            const track = new ItemTrack(child, container);
            this.items[child.id] = {
              key: String(child.id),
              childId: child.id,
              required: track.required,
              scanned: track.scanned,
              done: track.done,
              name: track.name,
              sku: track.sku,
              _childScans: { [child.id]: track.scanned },
            };
          }
        }
      }
    },

    /**
     * Load tote-wide inventory rows from inventory/inventory?license_plate_no=.
     * Rows are grouped by item code and required qty is total allocated_quantity.
     * On post-close refresh, scanned state is reset to 0 — the fresh C7 inventory
     * reflects what's still in the tote, not what was packed in previous shipments.
     */
    ingestFromInventory(containerNo, rows) {
      this.ensure(containerNo);
      const grouped = new Map();

      for (const row of rows || []) {
        const item = row.item || {};
        const sku = String(item.item_code || row.item_code || row.item_id || '—').trim();
        if (!sku || sku === '—') continue;
        const qty = Number(row.allocated_quantity ?? row.allocatedUnits ?? 0) || 0;
        if (qty <= 0) continue;

        const g = grouped.get(sku) || {
          key: `inv:${sku}`,
          source: 'inventory',
          required: 0,
          scanned: 0, // reset — C7 inventory is the source of truth after each close
          done: false,
          name: item.description || sku,
          sku,
          _childScans: {},
        };
        g.required += qty;
        grouped.set(sku, g);
      }

      if (!grouped.size) return;

      this.items = {};
      for (const row of grouped.values()) {
        row.done = row.scanned >= row.required;
        this.items[row.key] = row;
      }
    },

    syncFromTrack(track) {
      if (!track?.child?.id) return;

      // Old GPC-backed rows are keyed by child id.
      const childRow = this.items[track.child.id];
      if (childRow) {
        childRow.scanned = track.scanned;
        childRow.done = track.done;
        return;
      }

      // Inventory-backed rows are keyed by SKU and tick down as matching shipment
      // children are scanned, even when the current shipment changes inside one SIBP tote.
      const sku = track.sku || track.child?.shipmentDetail?.item?.item_code;
      const row = sku ? this.items[`inv:${sku}`] : null;
      if (!row) return;

      const childId = String(track.child.id);
      const prev = Number(row._childScans?.[childId] || 0);
      const next = Number(track.scanned || 0);
      const delta = next - prev;
      if (!delta) return;

      row._childScans = row._childScans || {};
      row._childScans[childId] = next;
      row.scanned = Math.min(Math.max(0, row.scanned + delta), row.required);
      row.done = row.scanned >= row.required;
    },

    get allItems() { return Object.values(this.items); },
    get remainingQty() {
      return this.allItems.reduce((sum, t) => sum + Math.max(0, t.required - t.scanned), 0);
    },
  };

  /** Per-item packing state */
  class ItemTrack {
    constructor(child, sourceContainer = null) {
      this.child    = child;
      this.required = child.quantity;
      this._originalRequired = child.quantity;
      this.sourceContainerNo = sourceContainer?.container_no || sourceContainer?.container_number || child.source_container_no || child.container_no || child.shipment_container_no || child.shipmentContainer?.container_no || null;
      this.sourceContainerId = sourceContainer?.id || child.source_container_id || child.container_id || child.shipment_container_id || child.shipmentContainer?.id || null;

      // Pre-populate from server status so already-packed items show correctly.
      // status_id 6/7 = fully packed, status_id 5 = partially packed.
      // quantity_packed is the server-confirmed packed quantity.
      const statusId     = child.status_id || child.status?.id || 0;
      const qtyPacked    = child.quantity_packed || 0;
      const alreadyDone  = statusId >= 6;
      this.scanned  = alreadyDone ? child.quantity : qtyPacked;
      this.done     = alreadyDone;
      this._apiOk   = alreadyDone; // server-confirmed if already done
      this._moveQueued = false;

      const item = child.shipmentDetail?.item || {};

      // The child's allocated UOM ID — used to scope barcode matching.
      // Each child is allocated against a specific UOM (Each, Carton etc).
      // We must only match barcodes for THAT UOM, not all UOMs on the item.
      // Otherwise a Carton-UOM child and an Each-UOM child for the same item
      // both match the same barcodes, causing move-into-container to fire
      // against the wrong child ID → C7 500 "completePacking() on null".
      const allocatedUomId = child.item_unit_of_measure_id
        || child.itemUnitOfMeasure?.id
        || null;

      // Build matchable barcodes scoped to the allocated UOM.
      // Always include item_code as a fallback (matches both UOM children,
      // but in that case the operator should scan the specific barcode).
      this.barcodes = new Set([
        (item.item_code || '').toLowerCase(),
        ...(item.itemUnitOfMeasures || [])
          .filter(u => !allocatedUomId || u.id === allocatedUomId)
          .flatMap(u =>
            (u.itemUnitOfMeasureReference || []).map(r => (r.reference || '').toLowerCase())
          ),
      ].filter(Boolean));

      // Store the allocated UOM for display/weight purposes
      this.allocatedUom = child.itemUnitOfMeasure || null;
      this.uomFactor    = child.itemUnitOfMeasure?.factor || 1;

      this.name = item.description || item.long_description || item.item_code || '—';
      this.sku  = item.item_code || '—';
      this.companyId = item.company_id;
    }

    matches(scan) {
      const s = scan.toLowerCase().trim();
      return this.barcodes.has(s) || [...this.barcodes].some(b => b && b === s);
    }
  }

  /** Active container session — reset for each outbound container */
  const Session = {
    profileId:         null,
    profile:           null, // full profile object
    packLocationId:    null,
    packLocationCode:  null,
    containerType:     null,
    confirmedCartonType: null,
    outboundContainer:   null, // created shipment-container object
    _nextContainerNo:    null, // pre-fetched for next container create
    phase:             'BOOT', // BOOT | PROFILE | SCAN_TOTE | SIBP_PROCESSING | SIBP_ITEM_SCAN | CHOOSE_BOX | PACKING | CLOSING | COMPLETE
    sibpSourceContainerNo: null,
    sibpProcessing: false,

    reset() {
      this.containerType     = null;
      this.confirmedCartonType = null;
      this.outboundContainer = null;
      this.phase             = 'SCAN_TOTE';
    },

    resetAll() {
      Object.assign(this, {
        profileId: null, profile: null, packLocationId: null,
        packLocationCode: null, containerType: null, confirmedCartonType: null, containerTypes: null,
        outboundContainer: null, _nextContainerNo: null, phase: 'PROFILE', sibpSourceContainerNo: null, sibpProcessing: false,
      });
      ShipmentCache.clear();
      SourceToteCache.clear();
    },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // 4b.  EVENT LOG
  //      In-memory log of operator-facing events (errors + successes).
  //      Append-only; cleared on close-container / full reset.
  //      DOM is lazy-built only when the operator opens the popover.
  // ─────────────────────────────────────────────────────────────────────────────

  const EventLog = {
    entries: [], // { type: 'ok'|'err', msg: string, time: string }

    _fmt() {
      const d = new Date();
      return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    },

    push(type, msg) {
      this.entries.push({ type, msg: String(msg || ''), time: this._fmt() });
      this._updatePill();
    },

    ok(msg)  { this.push('ok',  msg); },
    err(msg) { this.push('err', msg); },

    clear() {
      this.entries = [];
      this._updatePill();
      // If popover is open, re-render it empty
      const body = document.getElementById('mp-log-body');
      if (body) this._renderInto(body);
    },

    _updatePill() {
      const pill  = document.getElementById('mp-log-pill');
      const dot   = document.getElementById('mp-log-dot');
      const label = document.getElementById('mp-log-label');
      if (!pill || !dot || !label) return;
      const last = this.entries[this.entries.length - 1];
      if (!last) {
        dot.className   = 'mp-log-pill-dot';
        label.className = 'mp-log-pill-label';
        label.textContent = 'Console';
        return;
      }
      dot.className   = `mp-log-pill-dot ${last.type}`;
      label.className = `mp-log-pill-label ${last.type}`;
      label.textContent = last.msg;
    },

    _renderInto(body) {
      body.innerHTML = '';
      if (!this.entries.length) {
        body.append(h('div', { cls: 'mp-log-empty' }, 'No events yet this shipment.'));
        return;
      }
      // Most recent first
      for (const e of [...this.entries].reverse()) {
        const row  = h('div', { cls: 'mp-log-row' });
        const dot  = h('div', { cls: `mp-log-row-dot ${e.type}` });
        const msg  = h('div', { cls: `mp-log-row-msg ${e.type}` }, e.msg);
        const time = h('div', { cls: 'mp-log-row-time' }, e.time);
        row.append(dot, msg, time);
        body.append(row);
      }
    },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // 4.  WORKFLOW ENGINE
  //     Translates profile flags into UI behaviour decisions.
  // ─────────────────────────────────────────────────────────────────────────────

  const Workflow = {
    /** Does this profile require weight/dimension confirmation on close? */
    requiresDimsConfirm: () => !!Session.profile?.confirm_dimensions,
    requiresWeightConfirm: () => !!Session.profile?.confirm_weight,

    /** Auto-generate container number or let user type one? */
    autoGenerateContainer: () => !!Session.profile?.auto_generate_container_check,

    /** Whether to log item verification call
     * HAR analysis shows native C7 fires this regardless of log_packing flag.
     * Always enabled — it is best-effort and never blocks the operator.
     */
    logVerification: () => true,

    /** SIBP profiles are item-initiated: scan tote once, then scan an item to load its shipment. */
    isSIBP: () => /sibp/i.test(String(Session.profile?.name || Session.profile?.profile_name || '')),

    /** MIBP keeps the previous retained-source-container/reload flow. */
    isMIBP: () => /mibp/i.test(String(Session.profile?.name || Session.profile?.profile_name || '')),

    usesRetainedSourceFlow: () => Workflow.isMIBP(),

    usesItemInitiatedFlow: () => Workflow.isSIBP(),

    /** Continue to consigning after close-to-container? SIBP is pre-consigned. */
    continueToConsigning: () => !Workflow.isSIBP() && !!Session.profile?.continue_to_consigning,

    /** Profile-specific consigning profile ID. SIBP is pre-consigned, so none. */
    consigningProfileId: () => Workflow.isSIBP() ? null : (Session.profile?.consigning_profile_id || null),

    /** Default container type from profile */
    defaultContainerTypeId: () => Session.profile?.default_container_type_id || null,

    /** Whether user must confirm container type (vs auto-select default) */
    confirmContainerType: () => !!Session.profile?.confirm_container_type_check,

    /** Allow closing with items still remaining — enabled for all profiles except SIBP and MIBP */
    allowEarlyClose: () => !Workflow.isSIBP() && !Workflow.isMIBP(),

    /**
     * Determine close-to-container location.
     * HAR analysis shows close_to_location_id must always be the operator's
     * resolved pack station location — NOT profile.close_container_location_id,
     * which Canary7 uses internally only and returns ID=1 (invalid for close).
     */
    /** Whether to calculate container weight from packed items */
    calculateWeight: () => !!Session.profile?.calculate_container_weight,

    /**
     * Calculate total packed weight from items in ShipmentCache.
     * Used when calculate_container_weight=1 on the profile.
     * Falls back to container type default if item weights are unavailable.
     */
    /**
     * Calculate weight for this container from scanned items only.
     * Mirrors native C7 behaviour — each close sends the weight of items
     * packed into that specific container (confirmed via HAR: multi-piece
     * shipment weight=1.00 + weight=22.00 = total_net_weight 23.00).
     *
     * Tries item.weight / item.net_weight / item.gross_weight fields first.
     * If item weights are missing from GPC (common), falls back to a
     * proportional share of shipmentHeader.total_net_weight based on
     * scanned qty vs total qty.
     */
    calcPackedWeight() {
      const items = ShipmentCache.allItems;
      const sh = ShipmentCache.shipmentHeader || {};

      // Attempt 1: exact weights for units scanned in THIS piece only.
      // Weight source: GPC returns child.itemUnitOfMeasure.weight as null — the
      // real weight lives in item.itemUnitOfMeasures[], matched by the child's
      // allocated UOM id (confirmed via HAR).
      // Piece accounting: each track counts only its delta since the last close
      // (scanned − _scannedAtPieceStart), so a line split across pieces weighs
      // exactly what physically went into this box.
      let total = 0;
      let hasWeights = false;
      for (const track of items) {
        const pieceUnits = (track.scanned || 0) - (track._scannedAtPieceStart || 0);
        if (pieceUnits <= 0) continue;
        const ch   = track.child || {};
        const uom  = ch.itemUnitOfMeasure || {};
        const item = ch.shipmentDetail?.item || {};
        const matchedUom = (item.itemUnitOfMeasures || []).find(u => u.id === ch.item_unit_of_measure_id)
          || (item.itemUnitOfMeasures || [])[0]
          || uom;
        const w = parseFloat(
          matchedUom?.weight ||
          uom.weight ||
          item.weight ||
          item.net_weight ||
          item.gross_weight ||
          item.itemWeights?.[0]?.weight ||
          0
        );
        if (w > 0) hasWeights = true;
        total += w * pieceUnits;
      }
      if (hasWeights && total > 0) return Math.round(total * 1000) / 1000;

      // Attempt 2: proportional share of total_net_weight.
      // Use Session._currentPieceScannedQty which tracks only items scanned
      // in the current container — reset by onNewContainer each piece.
      const totalNetWeight = parseFloat(sh.total_net_weight || 0);
      if (totalNetWeight > 0) {
        const totalQty   = ShipmentCache.totalOriginalQty ||
          items.reduce((s, t) => s + (t._originalRequired ?? t.required ?? 0), 0);
        const scannedQty = Session._currentPieceScannedQty || 0;
        if (totalQty > 0 && scannedQty > 0) {
          return Math.round((totalNetWeight * scannedQty / totalQty) * 1000) / 1000;
        }
      }

      return null;
    },

    closeLocationId: () => Session.packLocationId,

    /**
     * Build verification API params from profile verification rules.
     * verification id 4 = "Only Accept Reference" → reference scan only.
     */
    verificationParams(track) {
      const sh  = ShipmentCache.shipmentHeader;
      const item = track.child.shipmentDetail?.item || {};
      return {
        item_code:     item.item_code,
        reference:     sh?.id || sh?.shipment_header_id,
        company_id:    track.companyId,
        item_code_use: 'Yes',
        screen:        'Packing',
        status:        'success',
      };
    },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // 5.  CORE API ACTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /** Called once per source container */
  async function fetchPackContainer(containerNo, profileId, itemCode = null) {
    const t0 = perfNow();
    const itemParam = itemCode ? encodeURIComponent(itemCode) : 'null';
    try {
      const result = await apiGet(
        `shipment/shipment-container/get-pack-container` +
        `&container_no=${encodeURIComponent(containerNo)}` +
        `&item_code=${itemParam}&profile=${profileId}&expand=${GPC_EXPAND}`
      );
      perfMark('get-pack-container', t0, itemCode ? `item ${itemCode}` : `container ${containerNo}`);
      return result;
    } catch (err) {
      perfMark('get-pack-container failed', t0, err.message);
      throw err;
    }
  }

  // Retool workflow proxy for tote inventory details.
  // Used because floor operators may not have C7 inventory/inventory permissions.
  // The workflow runs under a privileged service account that does.
  const RETOOL_TOTE_DETAILS_WORKFLOW_URL = 'https://api.retool.com/v1/workflows/b6bc8588-78ad-4a00-8a40-5cc6f495b4ed/startTrigger';
  const RETOOL_TOTE_DETAILS_API_KEY = 'retool_wk_9ab058313edc4add9ff09efdd342e8b3';

  function retoolWorkflowRequest(body) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Workflow-Api-Key': RETOOL_TOTE_DETAILS_API_KEY,
    };


    if (typeof GM_xmlhttpRequest === 'function') {
        return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: RETOOL_TOTE_DETAILS_WORKFLOW_URL,
          headers,
          data: JSON.stringify(body),
          timeout: 20000,
          onload: (res) => {
                            let payload = null;
            try { payload = res.responseText ? JSON.parse(res.responseText) : null; }
            catch (_) { payload = res.responseText; }
            if (res.status < 200 || res.status >= 300) {
              reject(new Error(`Retool workflow ${res.status}`));
              return;
            }
            resolve(payload);
          },
          onerror:   (e) => { console.error('[MalpaPack] retoolWorkflowRequest: onerror', e); reject(new Error('Retool workflow request failed')); },
          ontimeout: ()  => { console.error('[MalpaPack] retoolWorkflowRequest: timeout'); reject(new Error('Retool workflow request timed out')); },
        });
      });
    }

    return fetch(RETOOL_TOTE_DETAILS_WORKFLOW_URL, {
      method: 'POST', headers, body: JSON.stringify(body),
    }).then(async (res) => {
        const payload = await res.json().catch(() => res.text());
        if (!res.ok) throw new Error(`Retool workflow ${res.status}`);
      return payload;
    });
  }

  /**
   * Normalise whatever shape the Retool workflow returns into a flat array of rows.
   * Retool workflows can return data nested under different keys depending on how
   * the workflow output block is configured. We check every known shape.
   */
  function normaliseRetoolRows(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.result)) return payload.result;
    if (Array.isArray(payload.output)) return payload.output;
    if (Array.isArray(payload.queryResult?.data)) return payload.queryResult.data;
    for (const key of Object.keys(payload)) {
      const v = payload[key];
      if (Array.isArray(v)) return v;
      if (Array.isArray(v?.data)) return v.data;
      if (Array.isArray(v?.rows)) return v.rows;
    }
    console.warn('[MalpaPack] normaliseRetoolRows: no array found. Keys:', Object.keys(payload));
    return [];
  }

  /**
   * Tote-wide inventory details for the titlebar detail counter.
   * Routes through the Retool workflow so floor operators (who may lack
   * C7 inventory permissions) can still get tote counts.
   */
  async function fetchToteInventoryDetails(containerNo) {
    const container = String(containerNo || '').trim();
    if (!container) return [];
    const payload = await retoolWorkflowRequest({ container });
    return normaliseRetoolRows(payload);
  }

  async function fetchPackingProfiles() {
    return apiGet('configuration/shipment-packing-profile&per-page=100&page=1');
  }

  async function fetchContainerTypes() {
    return apiGet('configuration/container-type/get-shipment-container-type');
  }

  function publishContainerTypesForPackPrompt(types) {
    const list = Array.isArray(types) ? types : [];
    if (!list.length) return;
    try {
      sessionStorage.setItem('mp_pack_prompt_container_types', JSON.stringify(list));
      localStorage.setItem('mp_pack_prompt_container_types', JSON.stringify(list));
    } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent('malpa-pack-container-types', {
        detail: { containerTypes: list },
      }));
    } catch (_) {}
  }

  /** Fetch a single container type by ID — used after auto-create to get dims for pre-fill */
  async function fetchContainerTypeById(id) {
    return apiGet(`shipment/shipment-container/container-type&container_type_id=${id}`);
  }

  async function fetchLocationByCode(code) {
    return apiGet(
      `configuration/location/view-by-code&code=${encodeURIComponent(code.toLowerCase())}` +
      `&warehouse_id=${WAREHOUSE_ID}&location_class_id=6`
    );
  }

  async function autoGenerateContainerNumber() {
    const r = await apiGet('shipment/shipment-container/auto-generate-container-number');
    return r.container_number;
  }

  async function createShipmentContainer(containerNo, containerTypeId) {
    const sh = ShipmentCache.shipmentHeader;
    const ji = ShipmentCache.jobInstruction;
    return apiPost('shipment/shipment-container/create', {
      container_no:                containerNo,
      status_id:                   5,
      shipment_header_id:          sh.id,
      consignment_id:              sh.consignment_id,
      to_container:                1,
      job_instruction_id:          ji?.id || null,
      consolidation_dock_id:       null,
      container_type_id:           containerTypeId,
      status:                      0,
      allow_inter_warehouse_transfer: 0,
      restrict_twofactor:          0,
    });
  }

  /**
   * Fetch any existing open outbound containers for the current shipment.
   * Used to detect and reuse containers created before a page refresh,
   * rather than creating a new empty one each time.
   * Returns array of container objects, or empty array if none found.
   */
  async function fetchOpenOutboundContainersForShipment(shipmentHeaderId) {
    try {
      const data = await apiGet(
        `shipment/shipment-container` +
        `&shipment_header_id=${shipmentHeaderId}` +
        `&status_id=5` +   // 5 = open/packing
        `&to_container=1` + // outbound containers only
        `&per-page=10&page=1`
      );
      const items = Array.isArray(data) ? data : (data?.items || []);
      return items;
    } catch (err) {
      console.warn('[MalpaPack] Could not check for existing open containers:', err.message);
      return [];
    }
  }

  async function deleteAbandonedContainer(containerId) {
    try {
      await apiDelete(`shipment/shipment-container/delete&id=${containerId}`);
    } catch (err) {
      console.warn('[MalpaPack] Could not delete abandoned container:', containerId, err.message);
    }
  }

  /**
   * Delete EMPTY closed (status 7) outbound containers for a shipment at tote
   * load. An abandoned mid-shipment session leaves closed containers holding a
   * weight but no children (partial units are never moved). When the operator
   * reloads the tote, scan state is gone and those units get re-verified — so
   * every empty closed container's weight would be declared twice. Deleting
   * them at load self-heals the shipment: total declared weight stays exact
   * no matter how many times a session is abandoned.
   *
   * Never touches: open containers (5), consigned containers (9 — label
   * already exists), containers with children, or other shipments' containers
   * (the detail endpoint returns the whole consignment group — filter hard).
   */
  async function cleanupEmptyClosedContainers(shipmentHeaderId) {
    try {
      const listData = await apiGet(
        `shipment/shipment-container` +
        `&shipment_header_id=${shipmentHeaderId}` +
        `&status_id=7` +
        `&to_container=1` +
        `&per-page=20&page=1`
      );
      const closed = (Array.isArray(listData) ? listData : (listData?.items || []))
        .filter(c => c.status_id === 7 && c.to_container === 1 && c.shipment_header_id === shipmentHeaderId);
      if (!closed.length) return;

      const removed = [];
      for (const c of closed) {
        try {
          // Detail fetch to check emptiness. CRITICAL: this endpoint returns
          // every container in the consignment group — match id AND shipment.
          const detail = await apiGet(
            `shipment/shipment-container` +
            `&id=${c.id}` +
            `&expand=shipmentDetailChildren`
          );
          const arr = Array.isArray(detail) ? detail : [detail];
          const me = arr.find(d =>
            d && d.id === c.id && d.shipment_header_id === shipmentHeaderId
          );
          if (!me) continue; // can't confirm — leave it alone
          if ((me.shipmentDetailChildren || []).length > 0) continue; // has real contents

          await apiDelete(`shipment/shipment-container/delete&id=${c.id}`);
          removed.push(c.container_no);
        } catch (err) {
          console.warn(`[MalpaPack] Could not clean up empty container ${c.container_no}:`, err.message);
          EventLog.err(`⚠ Empty closed container ${c.container_no} could not be removed — check before consigning.`);
        }
      }

      if (removed.length) {
        // Verify they are actually gone — a silent delete failure would cause
        // a duplicate container at consign.
        const verify = await apiGet(
          `shipment/shipment-container` +
          `&shipment_header_id=${shipmentHeaderId}` +
          `&status_id=7&to_container=1&per-page=20&page=1`
        );
        const still = (Array.isArray(verify) ? verify : (verify?.items || []))
          .filter(c => removed.includes(c.container_no))
          .map(c => c.container_no);
        const gone = removed.filter(no => !still.includes(no));
        if (gone.length) {
          EventLog.ok(`Removed ${gone.length} empty container(s) from a previous session: ${gone.join(', ')} — repack those items.`);
          setStatus(`♻ Removed ${gone.length} empty container(s) from a previous session — repack those items.`, 'ok');
        }
        for (const no of still) {
          EventLog.err(`⚠ Container ${no} reported deleted but still exists — check before consigning.`);
        }
      }
    } catch (err) {
      console.warn('[MalpaPack] Empty-container cleanup failed:', err.message);
    }
  }

  /**
   * If an outbound container was created but never closed, delete it.
   * Only deletes containers in phase PACKING or CHOOSE_BOX — not CLOSING or COMPLETE.
   */
  function maybeDeleteAbandonedContainer() {
    const c = Session.outboundContainer;
    const phase = Session.phase;
    if (!c?.id) return;
    // Only abandon if we were mid-pack and never closed
    if (phase === 'PACKING' || phase === 'CHOOSE_BOX') {
      deleteAbandonedContainer(c.id);
    }
  }

  function enqueueVerification(track) {
    if (!Workflow.logVerification()) return;
    const p = Workflow.verificationParams(track);
    Q.enqueue({
      key: `verify-${track.child.id}`,
      fn: () => apiGet(
        `configuration/item/process-log-item-verification` +
        `&item_code=${encodeURIComponent(p.item_code)}` +
        `&reference=${p.reference}&company_id=${p.company_id}` +
        `&item_code_use=Yes&screen=Packing&status=success`
      ),
      // Verification is best-effort; don't rollback on failure
      onFailure: (err) => console.warn('[MalpaPack] Verification log failed:', err.message),
    });
  }

  function enqueueMoveIntoContainer(track, onFailure) {
    const c    = Session.outboundContainer;
    const loc  = Session.packLocationId;
    if (!c || !loc) return;
    // Use the real C7 child ID — local-only placeholders have _realChildId set
    const childId = track.child?._realChildId || track.child.id;
    if (track.child?._localOnly && !track.child?._realChildId) {
      // No real ID available — skip the API call entirely
      track._apiOk = true;
      updateCloseButtonReady();
      return;
    }
    const t0 = perfNow();
    track._moveQueued = true;
    track._apiOk = false;
    updateCloseButtonReady();
    Q.enqueue({
      key: `move-${childId}`,
      fn: () => apiGet(
        `shipment/shipment-container/move-into-container-v2` +
        `&shipment_detail_child_id=${childId}` +
        `&container_id=${c.id}` +
        `&into_location=${loc}` +
        `&custom_field_1=null&custom_field_2=null` +
        `&profile_id=${Session.profileId}`
      ),
      onSuccess: () => {
        track._apiOk = true;
        track._moveQueued = false;
        perfMark('move-into-container confirmed', t0, `child ${childId}`);
        updateCloseButtonReady();
      },
      onFailure: (err) => {
        track._moveQueued = false;
        perfMark('move-into-container failed', t0, `child ${childId}: ${err.message}`);
        // If C7 says completePacking() on null, the child ID is stale — it was
        // already split by a prior session or MIBP wave. Retrying the same ID
        // will never work. Refresh GPC to get the current child IDs instead.
        if (err.message && err.message.includes('completePacking')) {
          console.warn(`[MalpaPack] Stale child ${childId} — refreshing GPC to find replacement children.`);
          EventLog.err(`Child ${childId} was already split — refreshing shipment data…`);
          _refreshGPCAfterStaleChild(childId);
          return; // do not call onFailure — we're recovering
        }
        updateCloseButtonReady();
        onFailure && onFailure(err);
      },
    });
  }

  /**
   * Called when move-into-container returns completePacking() on null —
   * meaning the child was already split by a prior wave/session.
   * Re-fetches GPC to get the current children and moves those instead.
   */
  async function _refreshGPCAfterStaleChild(staleChildId) {
    try {
      const containerNo = ShipmentCache.sourceContainerNo;
      if (!containerNo || !Session.profileId) return;
      const data = await fetchPackContainer(containerNo, Session.profileId);
      const containers = Array.isArray(data) ? data : [data];
      // Rebuild ShipmentCache with fresh data — preserves already-scanned tracks
      const freshItems = {};
      for (const container of containers) {
        for (const child of container.shipmentDetailChildren || []) {
          if (!freshItems[child.id]) {
            // Carry over scanned state if we already had this child
            const existing = ShipmentCache.items[child.id];
            const track = new ItemTrack(child, container);
            if (existing) {
              track.scanned  = existing.scanned;
              track.done     = existing.done;
              track._apiOk   = existing._apiOk;
            }
            freshItems[child.id] = track;
          }
        }
      }
      ShipmentCache.items = freshItems;
      renderItems(R.rhFil?.value || '');
      updateProgress();
      updateDetailCounter();
      updateCloseButtonReady();
      EventLog.ok('Shipment data refreshed — stale children replaced. Rescan if needed.');
      setStatus('Shipment refreshed — check items and rescan if any show 0/N.', 'warn');
    } catch (err) {
      console.warn('[MalpaPack] GPC refresh after stale child failed:', err.message);
      EventLog.err(`Could not refresh shipment data: ${err.message}`);
    }
  }

  async function closeContainer(weight, length, width, height) {
    const t0 = perfNow();
    const c   = Session.outboundContainer;
    const loc = Workflow.closeLocationId();
    const url = API_BASE +
      `shipment/shipment-container/close-to-container` +
      `&close_to_location_id=${loc}` +
      `&container_id=${c.id}` +
      `&profile_id=${Session.profileId}` +
      `&weight=${weight}&length=${length}&width=${width}&height=${height}` +
      `&expand=shipmentHeader`;

    const res = await fetch(url, { method: 'GET', headers: mkHeaders() });
    const body = await res.json().catch(() => ({}));

    if (res.status === 401) throw new Error('Session expired — please log in again.');

    if (!res.ok) {
      // Log the full error body so it appears in DevTools for diagnosis
      console.warn('[MalpaPack] close-to-container non-200:', res.status, JSON.stringify(body));

      // ANY 500 from close-to-container is treated as a soft warning.
      // Canary7 closes the container server-side before running post-close
      // side effects (print routing, label generation). If those fail with
      // a 500 the container IS already closed — we can safely continue to
      // consigning. Only auth errors and network failures are hard failures.
      if (res.status === 500) {
        const msg = body.message || `Server error ${res.status}`;
        perfMark('close-to-container soft-500', t0, msg);
        return {
          id:             c.id,
          container_no:   c.container_no,
          status_id:      7,
          consignment_id: ShipmentCache.shipmentHeader?.consignment_id,
          _softError:     msg,   // surfaced as a UI warning, not a hard stop
        };
      }

      perfMark('close-to-container failed', t0, body.message || `API error ${res.status}`);
      throw new Error(body.message || `API error ${res.status}`);
    }

    perfMark('close-to-container', t0, `container ${c?.container_no || c?.id || ''}`);
    return body;
  }


  async function createConsignmentPieces(consignmentId) {
    const cpId = Workflow.consigningProfileId();
    if (!cpId) return null;
    return apiPost(
      `shipment/shipment-container/create-consignment-pieces` +
      `&consignment_id=${consignmentId}` +
      `&additional_label=0` +
      `&profile_id=${cpId}` +
      `&piece_creation_method=1`,
      {}
    );
  }

  async function setCarrierPieceNo(consignmentId, containerNo = undefined) {
    const containerParam = containerNo
      ? encodeURIComponent(containerNo)
      : 'undefined';
    return apiGet(
      `shipment/consignment-piece/set-carrier-piece-no` +
      `&container_no=${containerParam}&piece_number=` +
      `&consignment_id=${consignmentId}` +
      `&do_not_associate_container=1&do_not_verify_pieces=1`
    );
  }

  function associatePreConsignedSibpPiece(consignmentId, closeResp = {}) {
    if (!Workflow.isSIBP() || !consignmentId) return Promise.resolve();
    const containerNo = Session.outboundContainer?.container_no || closeResp?.container_no || '';
    if (!containerNo) return Promise.resolve();

    return setCarrierPieceNo(consignmentId, containerNo)
      .then(body => {
        _lastConsignmentId = consignmentId;
        if (R.reprintBtn) {
          R.reprintBtn.disabled = false;
          R.reprintBtn.title = `Reprint label for consignment ${consignmentId}`;
        }
        const tracking = normalizePiecesResponse(body)
          .map(p => p.tracking_number || p.carrier_piece_number)
          .filter(Boolean)
          .join(', ');
        console.log('[MalpaPack] SIBP pre-consigned carrier piece associated', tracking || consignmentId);
      })
      .catch(err => {
        // Surface the error to the operator with validation context, same as
        // the standard consign path — don't silently swallow SIBP failures.
        const warnings = preConsignValidation();
        if (warnings.length) {
          throw new Error(`${err.message} — possible cause: ${warnings.join(' | ')}`);
        }
        throw err;
      });
  }

  function normalizePiecesResponse(body) {
    if (!body) return [];
    if (Array.isArray(body)) return body;
    if (Array.isArray(body.items)) return body.items;
    if (Array.isArray(body.consignmentPieces)) return body.consignmentPieces;
    return [body];
  }

  /**
   * Validate shipment data before attempting to consign.
   * Returns an array of warning strings — empty means all clear.
   * These checks mirror the validations C7 performs server-side, surfacing
   * them to the operator before the consign call so they know what to fix.
   */
  function preConsignValidation() {
    const warnings = [];
    const sh  = ShipmentCache.shipmentHeader || {};
    const addr = sh.address || {};

    // Phone number
    const phone = String(addr.ship_to_phone_num || '').trim();
    if (!phone) warnings.push('No phone number on shipment address');

    // Email address
    const email = String(addr.ship_to_email_address || '').trim();
    if (!email) warnings.push('No email address on shipment address');

    // Shipment weight
    const weight = parseFloat(sh.total_net_weight || 0);
    if (!weight) warnings.push('Shipment total net weight is zero or missing');

    return warnings;
  }

  function startPostCloseConsigning(consignmentId, closeResp = {}) {
    // SIBP is pre-consigned. Do not create pieces and do not call
    // set-carrier-piece-no here; live tests returned C7 500s for that endpoint.
    if (Workflow.isSIBP()) return Promise.resolve();
    if (!Workflow.continueToConsigning() || !consignmentId) return Promise.resolve();

    const cpId = Workflow.consigningProfileId();
    if (!cpId) return Promise.resolve();

    const containerNo = Session.outboundContainer?.container_no || closeResp?.container_no || '';

    // NOTE: errors are NOT caught here — they propagate to the caller so the
    // UI can surface them to the operator and stay on the packing screen.
    // Store the consignment ID upfront so the reprint button works even if
    // create-consignment-pieces fails — the consignment exists in C7 regardless.
    _lastConsignmentId = consignmentId;
    if (R.reprintBtn) {
      R.reprintBtn.disabled = false;
      R.reprintBtn.title = `Reprint label for consignment ${consignmentId}`;
    }
    return createConsignmentPieces(consignmentId)
      .then(() => setCarrierPieceNo(consignmentId, containerNo))
      .then(body => {
        const tracking = normalizePiecesResponse(body)
          .map(p => p.tracking_number || p.carrier_piece_number)
          .filter(Boolean)
          .join(', ');
        if (tracking) console.log('[MalpaPack] Tracking number assigned:', tracking);
      })
      .catch(err => {
        // Consign failed — run validation checks to give operator a human-readable
        // explanation of the likely cause before re-throwing to the caller.
        // Validation only runs on failure — it never blocks a successful consign.
        const warnings = preConsignValidation();
        if (warnings.length) {
          throw new Error(`${err.message} — possible cause: ${warnings.join(' | ')}`);
        }
        throw err;
      });
  }

  /** Track the last successfully consigned consignment_id for reprint */
  let _lastConsignmentId = null;

  // ── v3.3.80: CONSIGN FIFO ──────────────────────────────────────────────────
  // Packing may overlap the previous shipment's consign chain, but consign
  // chains themselves must NEVER run concurrently: C7 handles concurrent
  // consignments fine, yet the printer gives no ordering guarantee — two boxes
  // on the bench with out-of-order labels risks wrong-label-on-box. All
  // create-consignment-pieces / set-carrier-piece-no chains queue here FIFO.
  // A failed chain keeps the queue alive (failure is surfaced separately).
  let _consignChain = Promise.resolve();
  function _enqueueConsign(fn) {
    const run = _consignChain.then(() => fn());
    _consignChain = run.catch(() => {});
    return run;
  }

  // v3.3.80: generation counter — increments every time a new shipment loads.
  // Async consign-failure handlers capture the generation at close time and
  // must not touch phase/scan-lock UI if a newer shipment is already active
  // (they still surface the error via badge/log/beep/reprint).
  let _shipmentGen = 0;
  /** Track the job_id for the currently loaded (or blocked) container */
  let _currentJobId = null;

  async function reprintLabel(consignmentId) {
    return apiGet(`shipment/consignment/reprint&consignment_id=${consignmentId}`);
  }

  /** Unassign a job so the current user can load it */
  async function unassignJob(jobId) {
    return apiGet(`job/job/unassign-job&job_id=${jobId}`);
  }

  /**
   * Look up a job_id from a container number.
   * Used only when GPC fails (job assigned to another user) and we need the
   * job_id to offer the unassign button without requiring the operator to know it.
   */
  async function fetchJobIdByContainer(containerNo) {
    const data = await apiGet(
      `job/job&expand=jobInstruction` +
      `&per-page=10&page=1&sort=-updated_at` +
      `&fields=id,job_no,jobInstruction` +
      `&close=1&container_number=${encodeURIComponent(containerNo)}`
    );
    const items = Array.isArray(data) ? data : (data?.items || []);
    if (!items.length) throw new Error('No job found for this container.');
    // Prefer the job linked via jobInstruction, else take the first result
    return items[0].id;
  }

  /**
   * Look up the last picker for a source tote using inventory-log.
   * Searches the last 3 days sorted by most recent transaction first.
   * Returns the username string, or null if not found.
   * Purely informational — always fires in background, never blocks the operator.
   */
  async function fetchLastPickerForTote(containerNo) {
    const pad  = n => String(n).padStart(2, '0');
    const fmt  = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now  = new Date();
    const past = new Date(now);
    past.setDate(past.getDate() - 3);
    const startDate = fmt(past);
    const endDate   = fmt(now);

    const data = await apiGet(
      `logging/inventory-log` +
      `&expand=no_of_pieces` +
      `&per-page=1` +
      `&page=1` +
      `&sort=-transaction_time` +
      `&start_date=${startDate}` +
      `&end_date=${endDate}` +
      `&transaction_type=picking` +
      `&license_plate_no=${encodeURIComponent(containerNo)}`
    );
    const rows = Array.isArray(data) ? data : (data?.items || []);
    return rows[0]?.username || null;
  }

  /** Update the picker badge in the log pill. Pass null to hide it. */
  /** Update the shipment number badge in the titlebar. */
  function updateShipBadge(shipmentNo, hasError = false) {
    const badge = document.getElementById('mp-ship-badge');
    if (!badge) return;
    // Only display human-readable shipment numbers — never raw numeric IDs
    // (consignment_id, header id etc). A pure number with no prefix is likely
    // an internal DB id that leaked in rather than a shipment number.
    const val = shipmentNo ? String(shipmentNo).trim() : '';
    const display = (val && !/^\d+$/.test(val)) ? val : (val ? `#${val}` : '—');
    badge.textContent = display;
    badge.classList.toggle('mp-ship-badge--error', !!hasError);
    badge.title = hasError
      ? `Shipment ${display} — consign failed, check details`
      : `Last shipment: ${display}`;
  }

  function updatePickerBadge(username) {
    const badge = document.getElementById('mp-picker-badge');
    if (!badge) return;
    if (username) {
      badge.textContent = `\u{1F464} ${username}`;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  async function packShortApiCall(childId, shortQty) {
    const c   = Session.outboundContainer;
    const loc = Session.packLocationId;
    return apiGet(
      `shipment/shipment-container/pack-short-v2` +
      `&into_location=${loc}` +
      `&shipment_detail_child_id=${childId}` +
      `&short_quantity=${shortQty}` +
      `&container_id=${c.id}` +
      `&custom_field_1=null&custom_field_2=null` +
      `&profile_id=${Session.profileId}`
    );
  }

  async function splitRemainingItemsForNextContainer() {
    const remainingTracks = ShipmentCache.pendingItems.slice();
    if (!remainingTracks.length) return 0;

    setStatus(`Closing this piece — moving ${remainingTracks.length} remaining line(s) to the next container…`, 'loading');

    let moved = 0;
    for (const track of remainingTracks) {
      const qtyRemaining = Math.max(0, track.required - track.scanned);
      if (qtyRemaining <= 0) continue;

      // Use the original child ID for the first pack-short call.
      // C7 may return a NEW child ID from pack-short — if so, subsequent
      // calls within this loop must use that new ID, not the original.
      // Using the fake fallback ID for subsequent pack-short calls causes
      // C7 500s because the fake ID doesn't exist in C7.
      let currentChildId = track.child.id;

      for (let i = 0; i < qtyRemaining; i++) {
        try {
          const shortResp = await packShortApiCall(currentChildId, 1);
          const nextChildId = shortResp?.id || shortResp?.child_id
            || shortResp?.shipmentDetailChild?.id
            || shortResp?.shipment_detail_child?.id;

          if (nextChildId && nextChildId !== currentChildId) {
            // C7 created a genuinely new child — store it and use it for next iteration
            const nextChild = shortResp?.shipmentDetailChild || shortResp?.shipment_detail_child || shortResp;
            const childForNext = { ...track.child, ...nextChild, id: nextChildId, quantity: 1, quantity_packed: 0, status_id: 0 };
            ShipmentCache.items[nextChildId] = new ItemTrack(childForNext, {
              id: track.sourceContainerId,
              container_no: track.sourceContainerNo,
            });
            // Next iteration uses the newly created child ID
            currentChildId = nextChildId;
          } else if (nextChildId && nextChildId === currentChildId) {
            // C7 returned the same ID — this unit stays on the same child.
            // Create a local placeholder only for UI tracking — do NOT send
            // this fake ID to C7 for pack-short or move-into-container.
            // The actual packing will be handled by the real child ID.
            const fallbackId = `${currentChildId}-local-${Date.now()}-${i}`;
            const childForNext = { ...track.child, id: fallbackId, quantity: 1, quantity_packed: 0, status_id: 0, _localOnly: true };
            ShipmentCache.items[fallbackId] = new ItemTrack(childForNext, {
              id: track.sourceContainerId,
              container_no: track.sourceContainerNo,
            });
            ShipmentCache.items[fallbackId]._realChildId = currentChildId;
          } else {
            // No usable ID returned — skip, don't create fake IDs
            console.warn('[MalpaPack] pack-short returned no usable child ID for', currentChildId);
          }

          track.required = Math.max(track.scanned, track.required - 1);
          track.done = track.scanned >= track.required;
          track._apiOk = track.done ? track._apiOk : false;
          moved++;
        } catch (shortErr) {
          console.warn('[MalpaPack] pack-short split error for child', currentChildId, shortErr.message);
          throw shortErr;
        }
      }
    }

    updateProgress();
    updateDetailCounter();
    renderItems(R.rhFil?.value || '');
    return moved;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 6.  AUDIO
  // ─────────────────────────────────────────────────────────────────────────────

  let _actx = null;
  function ac() {
    if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
    return _actx;
  }
  function beep(type = 'ok') {
    try {
      const ctx = ac();
      const now = ctx.currentTime;

      if (type === 'scan_partial') {
        // ── Partial scan: single bright sine tick at C6 (1047 Hz) ──────────
        // Short, satisfying, leaves operator wanting more. Cuts through
        // warehouse noise cleanly. Fast attack, short decay.
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.value = 1047;
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(0.32, now + 0.008);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        o.start(now); o.stop(now + 0.14);

      } else if (type === 'scan_done') {
        // ── Item fully verified: A5 → E6 perfect fifth (880 → 1319 Hz) ────
        // Two-note rising interval — musically "resolved", clearly more
        // rewarding than the partial tick. Sine waves feel clean and bright.
        // Slightly longer than partial so the difference is felt, not just heard.
        [[880, 0], [1319, 0.13]].forEach(([freq, offset]) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.type = 'sine';
          o.frequency.value = freq;
          const t = now + offset;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.30, t + 0.010);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.20);
          o.start(t); o.stop(t + 0.20);
        });

      } else if (type === 'all_done') {
        // ── All items verified: G5 → C6 → G6 triumphant arpeggio ───────────
        // Three ascending notes, triangle wave for warmth and presence.
        // Swell attack makes it feel like a reward, not a warning.
        // Clearly more celebratory than item_done; distinct from beepContainerEmpty.
        [[784, 0], [1047, 0.16], [1568, 0.32]].forEach(([freq, offset]) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.type = 'triangle';
          o.frequency.value = freq;
          const t = now + offset;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.36, t + 0.030);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
          o.start(t); o.stop(t + 0.26);
        });

      } else if (type === 'container_closed') {
        // ── Container closed + label printed: 5-note major cascade + shimmer ─
        // This is the highest reward tier in the packing cycle — the moment the
        // physical box is sealed and the label is printing. Needs to feel final,
        // ceremonial, and unmistakably different from the 3-note all_done.
        //
        // Pattern: C5 → E5 → G5 → C6 → E6 (C major arpeggio, full octave + third)
        // then a high shimmer at G6 after a brief pause for a "crown" effect.
        // Triangle wave throughout for warmth; volume swell on each note so it
        // builds rather than just plays flat. Slight pitch vibrato on final note
        // adds sparkle without feeling electronic.
        const cascade = [
          [523,  0.00, 0.32, 0.038],   // C5 — foundation
          [659,  0.08, 0.30, 0.032],   // E5 — rises
          [784,  0.16, 0.30, 0.030],   // G5 — builds
          [1047, 0.25, 0.38, 0.028],   // C6 — arrival
          [1319, 0.34, 0.36, 0.025],   // E6 — peak
          [1568, 0.46, 0.28, 0.020],   // G6 — shimmer crown
        ];
        cascade.forEach(([freq, offset, gain, attack]) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.type = 'triangle';
          o.frequency.value = freq;
          const t = now + offset;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(gain, t + attack);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.30);
          o.start(t); o.stop(t + 0.30);
        });

      } else if (type === 'err') {
        // ── Error: descending sawtooth — harsh, impossible to miss ──────────
        [320, 160].forEach((freq, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.type = 'sawtooth';
          o.frequency.value = freq;
          const t = now + i * 0.14;
          g.gain.setValueAtTime(0.28, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
          o.start(t); o.stop(t + 0.18);
        });

      } else if (type === 'warn') {
        // ── Warning: flat two-tone ───────────────────────────────────────────
        [440, 380].forEach((freq, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.frequency.value = freq;
          const t = now + i * 0.13;
          g.gain.setValueAtTime(0.24, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
          o.start(t); o.stop(t + 0.18);
        });

      } else {
        // ── Legacy fallback for any remaining 'ok' / 'done' callers ─────────
        const seqs = { ok: [880, 1100], done: [660, 880, 1100] };
        const seq  = seqs[type] || seqs.ok;
        seq.forEach((freq, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.frequency.value = freq;
          const t = now + i * 0.13;
          g.gain.setValueAtTime(0.28, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
          o.start(t); o.stop(t + 0.18);
        });
      }
    } catch (_) {}
  }

  function beepContainerEmpty() {
    // Triumphant ascending fanfare — clearly different from normal 'done'
    try {
      const ctx  = ac();
      const seq  = [523, 659, 784, 1047]; // C5 E5 G5 C6
      seq.forEach((freq, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = freq;
        o.type = 'triangle';
        const t = ctx.currentTime + i * 0.18;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.35, t + 0.04);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
        o.start(t); o.stop(t + 0.28);
      });
    } catch (_) {}
  }


  // ─────────────────────────────────────────────────────────────────────────────

  function injectCSS() {
    if (document.getElementById('mp-css')) return;
    document.head.insertAdjacentHTML('beforeend', `
<style id="mp-css">
/* ── Canary7-matched design tokens ── */
:root {
  /* Option 2 — C7-paired high-performance palette */
  --c7-bg:       #eef1f5;
  --c7-surf:     #ffffff;
  --c7-surf2:    #f9f9fa;
  --c7-surf3:    #eef9fd;
  --c7-border:   #e1e6ef;
  --c7-border2:  #c0cadd;
  --c7-text:     #394967;
  --c7-muted:    #9faecb;
  --c7-muted2:   #6b7280;
  --c7-teal:     #2ea8d6;
  --c7-amber:    #fabb3d;
  --mp-brand:    #6fc3eb;
  --c7-green:    #79c447;
  --c7-green-bg: #eff9eb;
  --c7-green-bd: #bde5ae;
  --c7-red:      #ff5454;
  --c7-amber-bg: #fff7e6;
  --c7-font:     -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
  --c7-mono:     'SF Mono', 'Fira Code', Consolas, monospace;
  --c7-r:        4px;
}

/* ══ TAB INTEGRATION — Canary7 tab-bar style ══ */
/* The pack view fills the main content area like a native C7 tab */
#mp-tab-view {
  position: fixed;
  /* Positioned by positionTabView() based on actual C7 content area */
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 100;
  background: var(--c7-surf2);
  display: flex;
  flex-direction: column;
  animation: mpTabIn .12s ease;
  overflow: hidden;
}
@keyframes mpTabIn { from { opacity: 0 } to { opacity: 1 } }

/* Tab chip injected into C7's tab bar */
.mp-tab-chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 40px; padding: 0 14px 0 12px;
  background: var(--c7-surf2);
  border-bottom: 2px solid var(--c7-teal);
  color: #fff;
  font-family: var(--c7-font); font-size: 17px; font-weight: 500;
  cursor: pointer; user-select: none; flex-shrink: 0;
  position: relative;
}
.mp-tab-chip .mp-tab-icon {
  width: 16px; height: 16px;
  background: var(--c7-amber);
  border-radius: 3px;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 800; color: #173140;
  flex-shrink: 0;
}
.mp-tab-chip .mp-tab-close {
  margin-left: 4px; font-size: 18px;
  color: var(--c7-muted2); background: none; border: none;
  cursor: pointer; padding: 0 2px; line-height: 1;
  border-radius: 3px; transition: color .1s, background .1s;
}
.mp-tab-chip .mp-tab-close:hover { color: var(--c7-text); background: var(--c7-surf3); }

/* ══ MAIN LAYOUT ══ */
.mp-layout {
  display: grid;
  grid-template-columns: 420px 1fr;
  flex: 1;
  overflow: hidden;
  border-top: 1px solid var(--c7-border);
}

/* ══ LEFT PANEL ══ */
.mp-left {
  background: var(--c7-surf);
  border-right: 1px solid var(--c7-border);
  display: flex; flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
}
.mp-left::-webkit-scrollbar { width: 4px; }
.mp-left::-webkit-scrollbar-thumb { background: var(--c7-border2); border-radius: 2px; }

/* ══ TAB TITLEBAR — spans full width of view, looks like C7 tab ══ */
.mp-titlebar {
  background: var(--c7-surf);
  border-bottom: 1px solid var(--c7-border);
  display: flex; align-items: center; gap: 0;
  height: 44px; flex-shrink: 0;
  padding: 0;
}
.mp-titlebar-tab {
  display: flex; align-items: center; gap: 8px;
  height: 100%; padding: 0 16px;
  border-bottom: 2px solid #6fc3eb;
  background: var(--c7-surf2);
  flex-shrink: 0;
}
.mp-titlebar-icon {
  width: 24px; height: 24px; background: transparent;
  border-radius: 4px; overflow: hidden; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
.mp-titlebar-icon img { width: 100%; height: 100%; object-fit: cover; border-radius: 4px; }
.mp-titlebar-icon-fb { font-size: 14px; font-weight: 800; color: #fff; background: #6fc3eb;
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border-radius: 4px; }
.mp-titlebar-name {
  font-size: 17px; font-weight: 500; color: var(--c7-text); white-space: nowrap;
}
.mp-titlebar-close {
  background: none; border: none; cursor: pointer;
  color: var(--c7-muted2); font-size: 20px; line-height: 1;
  padding: 2px 4px; border-radius: 3px; margin-left: 6px;
  transition: color .1s, background .1s;
}
.mp-titlebar-close:hover { color: var(--c7-text); background: var(--c7-surf3); }
.mp-titlebar-spacer { flex: 1; }
.mp-titlebar-queue {
  margin-right: 12px;
  font-family: var(--c7-mono); font-size: 14px; color: var(--c7-muted2);
  background: var(--c7-surf3); border: 1px solid var(--c7-border);
  border-radius: 10px; padding: 2px 10px; white-space: nowrap;
}
.mp-titlebar-queue.busy { color: var(--c7-amber); border-color: #f2c15a; }

/* ══ LEFT PANEL HEADER ══ */
.mp-lph {
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--c7-border);
  flex-shrink: 0;
}
.mp-lph-title {
  font-size: 17px; font-weight: 600; color: var(--c7-text);
  display: flex; align-items: center; gap: 8px;
}
.mp-lph-title .mp-lph-icon {
  width: 22px; height: 22px; background: var(--c7-amber);
  border-radius: 4px; display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 800; color: #173140; flex-shrink: 0;
}
.mp-lph-sub { font-size: 15px; color: var(--c7-muted); margin: 0; }

/* ══ SECTION BLOCKS ══ */
.mp-section {
  padding: 14px 16px;
  border-bottom: 1px solid var(--c7-border);
  flex-shrink: 0;
}
.mp-section:last-child { border-bottom: none; }

/* ══ FIELD LABELS (C7 style) ══ */
.mp-lbl {
  font-size: 15px; font-weight: 700; letter-spacing: 1px;
  text-transform: uppercase; color: var(--c7-text);
  margin: 0 0 8px;
  display: block;
}

/* ══ INPUTS ══ */
.mp-sg { display: flex; gap: 6px; }
.mp-si {
  flex: 1; background: var(--c7-bg);
  border: 1px solid var(--c7-border2);
  border-radius: var(--c7-r); color: var(--c7-text);
  font-family: var(--c7-font); font-size: 22px;
  padding: 14px 16px; outline: none;
  min-height: 54px;
  transition: border-color .12s;
}
.mp-si:focus { border-color: var(--c7-teal); }
.mp-si::placeholder { color: var(--c7-muted); }
.mp-si:disabled { opacity: .5; cursor: not-allowed; }

/* ══ QTY ROW — sits between scan label and scan input ══ */
.mp-qty-row {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 6px;
}
.mp-qty-lbl {
  font-size: 12px; font-weight: 600; color: var(--c7-muted2);
  text-transform: uppercase; letter-spacing: .04em;
  white-space: nowrap;
}
.mp-qty-in {
  flex: 1;
  background: var(--c7-card2); color: var(--c7-text);
  border: 1px solid var(--c7-border); border-radius: 6px;
  font-size: 15px; font-weight: 700; text-align: center;
  padding: 0 6px; height: 38px;
  -moz-appearance: textfield;
}
.mp-qty-in::-webkit-outer-spin-button,
.mp-qty-in::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.mp-qty-in:focus { border-color: var(--c7-teal); outline: none; }
.mp-qty-in:disabled { opacity: .5; cursor: not-allowed; }

/* ══ BUTTONS ══ */
.mp-sb {
  background: var(--c7-teal); color: #fff;
  font-weight: 600; font-size: 21px; font-family: var(--c7-font);
  border: none; border-radius: var(--c7-r);
  padding: 0 18px; cursor: pointer; white-space: nowrap; flex-shrink: 0;
  transition: background .1s; min-height: 54px;
}
.mp-sb:hover { background: #1985ac; }
.mp-sb:disabled { background: var(--c7-border2); color: var(--c7-muted2); cursor: not-allowed; }

.mp-btn {
  border: none; border-radius: var(--c7-r);
  padding: 10px 14px; cursor: pointer;
  font-family: var(--c7-font); font-size: 17px; font-weight: 600;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  transition: background .1s, opacity .1s; white-space: nowrap;
}
.mp-btn:disabled { opacity: .35; cursor: not-allowed; pointer-events: none; }
.btn-green  { background: #79c447; color: #fff; }
.btn-green:hover:not(:disabled) { background: #5aa632; }
.btn-ghost  { background: var(--c7-surf3); color: var(--c7-text); border: 1px solid var(--c7-border2); }
.btn-ghost:hover:not(:disabled) { background: #eef9fd; }
.mp-row { display: flex; gap: 8px; }
.mp-row .mp-btn { flex: 1; }

/* ══ CUSTOM DROPDOWN ══ */
.mp-dd { position: relative; width: 100%; user-select: none; }
.mp-dd-btn {
  width: 100%; background: var(--c7-bg); border: 1px solid var(--c7-border2);
  border-radius: var(--c7-r); color: var(--c7-text);
  font-family: var(--c7-font); font-size: 17px;
  padding: 8px 12px; outline: none; cursor: pointer;
  display: flex; align-items: center; justify-content: space-between;
  transition: border-color .12s; box-sizing: border-box; height: 38px;
}
.mp-dd-btn:hover { border-color: var(--c7-teal); }
.mp-dd-btn.open  { border-color: var(--c7-teal); border-bottom-color: transparent; border-radius: var(--c7-r) var(--c7-r) 0 0; }
.mp-dd-btn .arr  { font-size: 14px; color: var(--c7-muted); transition: transform .15s; }
.mp-dd-btn.open .arr { transform: rotate(180deg); }
.mp-dd-list {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 9999;
  background: var(--c7-bg); border: 1px solid var(--c7-teal);
  border-top: none; border-radius: 0 0 var(--c7-r) var(--c7-r);
  max-height: 200px; overflow-y: auto;
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
}
.mp-dd-opt {
  padding: 9px 12px; font-size: 17px; cursor: pointer;
  border-bottom: 1px solid var(--c7-border);
  color: var(--c7-text); font-family: var(--c7-font);
  transition: background .08s;
}
.mp-dd-opt:last-child { border-bottom: none; }
.mp-dd-opt:hover  { background: var(--c7-surf3); }
.mp-dd-opt.active { background: var(--c7-surf2); color: var(--c7-teal); }

/* ══ SKELETON LOADING ROWS (v3.3.82) ══ */
.mp-skel-row {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 16px; border-bottom: 1px solid var(--c7-border);
}
.mp-skel {
  background: linear-gradient(90deg, var(--c7-bg) 25%, var(--c7-surf3) 50%, var(--c7-bg) 75%);
  background-size: 200% 100%;
  animation: mpSkel 1.1s linear infinite;
  border-radius: 4px;
}
@keyframes mpSkel { from { background-position: 200% 0 } to { background-position: -200% 0 } }
.mp-skel-info { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.mp-skel-loading-note {
  padding: 12px 16px; font-size: 15px; color: var(--c7-muted2);
  display: flex; align-items: center; gap: 8px;
}

/* ══ INFO CARDS ══ */
.mp-card {
  background: var(--c7-bg); border: 1px solid var(--c7-border);
  border-radius: var(--c7-r); padding: 12px;
}
.mp-crow {
  display: flex; justify-content: space-between; align-items: center;
  padding: 5px 0; border-bottom: 1px solid var(--c7-border); font-size: 16px;
}
.mp-crow:last-child { border-bottom: none; padding-bottom: 0; }
.mp-crow:first-child { padding-top: 0; }
.mp-ck { color: var(--c7-muted); font-size: 15px; }
.mp-cv {
  font-family: var(--c7-mono); font-size: 15px; font-weight: 500;
  text-align: right; max-width: 180px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c7-text);
}
.mp-cv.hi     { color: var(--c7-amber); }
.mp-cv.green  { color: var(--c7-green); }
.mp-cv.blue   { color: var(--c7-teal);  }
.mp-crow:has(.mp-cv.order) .mp-ck,
.mp-cv.order { font-weight: 800; }

/* ══ CONTAINER TYPE PICKER ══ */
.mp-ctypes { display: flex; flex-direction: column; gap: 4px; }
.mp-ctype {
  background: var(--c7-bg); border: 1px solid var(--c7-border2);
  border-radius: var(--c7-r); padding: 10px 12px; cursor: pointer;
  transition: border-color .12s; display: flex; align-items: center; gap: 10px;
}
.mp-ctype:hover { border-color: var(--c7-teal); }
.mp-ctype.sel   { border-color: var(--c7-teal); background: #eef9fd; }
.mp-ctype-name  { font-weight: 600; font-size: 17px; color: var(--c7-text); }
.mp-ctype-dims  { font-size: 15px; color: var(--c7-muted); font-family: var(--c7-mono); margin-top: 2px; }
.mp-ctype-icon  { font-size: 24px; flex-shrink: 0; }

/* ══ DIMS ══ */
.mp-dims { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

.mp-carton-confirm { display: flex; flex-direction: column; gap: 10px; }
.mp-expected-carton {
  border: 1px solid rgba(34,211,238,.28);
  background: rgba(34,211,238,.08);
  border-radius: 10px;
  padding: 12px;
  text-align: center;
  align-self: center;
  width: 100%;
  box-sizing: border-box;
}
.mp-expected-title {
  font-size: 15px;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--c7-muted);
  margin-bottom: 4px;
}
.mp-expected-name {
  font-size: 19px;
  font-weight: 800;
  color: var(--c7-text);
  line-height: 1.25;
}
.mp-expected-dims {
  margin-top: 6px;
  font-family: var(--c7-mono);
  font-size: 16px;
  color: var(--c7-muted);
}
.mp-carton-confirmed .mp-expected-carton {
  border-color: rgba(16,185,129,.45);
  background: rgba(16,185,129,.10);
}
.mp-dim-wrap { display: flex; flex-direction: column; gap: 4px; }
.mp-dim-label { font-size: 14px; color: var(--c7-muted); letter-spacing: .6px; text-transform: uppercase; }
.mp-dim-in {
  background: var(--c7-bg); border: 1px solid var(--c7-border2);
  border-radius: var(--c7-r); color: var(--c7-text);
  font-family: var(--c7-font); font-size: 18px;
  padding: 7px 10px; outline: none; width: 100%; box-sizing: border-box;
  transition: border-color .12s;
}
.mp-dim-in:focus { border-color: var(--c7-teal); }

/* ══ PROGRESS BAR ══ */
.mp-prog { background: var(--c7-border); border-radius: 2px; height: 4px; overflow: hidden; }
.mp-progb { height: 100%; background: var(--c7-teal); border-radius: 2px; transition: width .3s ease; }
.mp-progb.full { background: var(--c7-green); }

/* ══ ROLLBACK BANNER ══ */
.mp-rollback-banner {
  margin: 0 16px 0;
  background: #fff0f0; border: 1px solid #ffc9c9;
  border-radius: var(--c7-r); padding: 10px 12px; font-size: 16px;
  color: var(--c7-red); display: flex; gap: 8px;
}

/* ══ RIGHT PANEL ══ */
.mp-right { display: flex; flex-direction: column; overflow: hidden; background: var(--c7-surf2); }

/* ══ ITEMS HEADER ══ */
.mp-rh {
  padding: 0 20px;
  background: var(--c7-surf);
  border-bottom: 1px solid var(--c7-border);
  display: flex; align-items: center; gap: 12px;
  height: 52px; flex-shrink: 0;
}
.mp-rh-title {
  font-size: 18px; font-weight: 600; color: var(--c7-text);
  display: flex; align-items: center; gap: 8px;
}
.mp-rh-cnt {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--c7-surf3); color: var(--c7-muted);
  font-size: 15px; font-weight: 700; font-family: var(--c7-mono);
  min-width: 22px; height: 20px; padding: 0 6px;
  border-radius: 10px;
}
.mp-rh .sp { flex: 1; }
.mp-filter {
  background: var(--c7-bg); border: 1px solid var(--c7-border2);
  border-radius: var(--c7-r); color: var(--c7-text);
  font-size: 17px; padding: 6px 12px; outline: none; width: 180px;
  transition: border-color .12s; font-family: var(--c7-font);
}
.mp-filter:focus { border-color: var(--c7-teal); }
.mp-filter::placeholder { color: var(--c7-muted); }

/* ══ QUEUE BADGE ══ */
.mp-tb-queue {
  font-family: var(--c7-mono); font-size: 14px; color: var(--c7-muted2);
  background: var(--c7-surf3); border: 1px solid var(--c7-border);
  border-radius: 10px; padding: 2px 8px; white-space: nowrap;
}
.mp-tb-queue.busy { color: var(--c7-amber); border-color: #f2c15a; }

/* ══ ITEM LIST ══ */
.mp-list { flex: 1; overflow-y: auto; padding: 0; }
.mp-list::-webkit-scrollbar { width: 6px; }
.mp-list::-webkit-scrollbar-thumb { background: var(--c7-border2); border-radius: 3px; }
.mp-list::-webkit-scrollbar-track { background: transparent; }

/* ══ ITEM ROW — warehouse-optimised: large, clear, readable at arm's length ══ */
.mp-item {
  display: grid;
  grid-template-columns: 1fr 260px;
  align-items: center;
  min-height: 100px;
  padding: 0;
  border-bottom: 3px solid var(--c7-border2);
  border-left: 4px solid transparent;
  cursor: default;
  transition: background .08s, border-left-color .15s;
  position: relative;
}
.mp-item:hover { background: var(--c7-surf3); }

/* Pending — waiting to be scanned */
.mp-item.pending {
  border-left-color: transparent;
  background: var(--c7-surf2);
}

/* Partial — some units scanned */
.mp-item.partial {
  border-left-color: var(--c7-amber);
  background: rgba(245,158,11,0.08);
}

/* Done — fully verified ✓ — bright and unmistakable */
.mp-item.done {
  border-left: 6px solid #79c447 !important;
  border-right: 4px solid #79c447 !important;
  background: linear-gradient(90deg, rgba(16,185,129,0.25) 0%, rgba(16,185,129,0.12) 40%, rgba(16,185,129,0.08) 100%) !important;
}

/* Done banner — full-width green strip at top of done rows */
.mp-item.done::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 4px;
  background: #79c447;
  opacity: 1;
}

/* Done row bottom border — full green */
.mp-item.done::after {
  content: '';
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 3px;
  background: rgba(16,185,129,0.55);
}

/* Rollback */
.mp-item.rollback {
  border-left-color: var(--c7-red);
  background: #fff0f0;
  animation: shake .3s ease;
}
@keyframes shake {
  0%,100% { transform: translateX(0); }
  25% { transform: translateX(-5px); }
  75% { transform: translateX(5px); }
}

/* Item info column */
.mp-item-info {
  padding: 16px 12px 16px 20px;
  display: flex; flex-direction: column; justify-content: center; gap: 5px;
  min-width: 0;
}
.mp-iname {
  font-size: 24px; font-weight: 700; color: var(--c7-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.2;
}
.mp-isku {
  font-family: var(--c7-mono); font-size: 19px; color: var(--c7-muted);
  font-weight: 500;
}
.mp-icontainer {
  display: inline-flex; align-items: center; gap: 6px;
  width: fit-content; margin-top: 2px; padding: 3px 9px;
  border: 1px solid rgba(220,38,38,.35);
background: rgba(220,38,38,.12);
color: #b91c1c;
  font-family: var(--c7-mono); font-size: 17px; font-weight: 800;
  letter-spacing: .2px;
}
.mp-item.done .mp-iname { color: #4f9c2f; }
.mp-item.done .mp-isku  { color: #5aa632; }
.mp-item.done .mp-icontainer { color: #4f9c2f; border-color: rgba(121,196,71,.35); background: rgba(121,196,71,.12); }

/* Quantity column */
.mp-item-qty {
  display: flex;
  flex-wrap: nowrap;
  align-items: center; justify-content: center;
  padding: 16px 20px 16px 0; gap: 8px;
  white-space: nowrap;
}
.mp-iqty-main,
.mp-iqty-of {
  min-width: 64px;
  padding: 8px 10px;
  border-radius: var(--c7-r);
  font-family: var(--c7-mono); font-size: 44px; font-weight: 800;
  line-height: 1; text-align: center;
}
.mp-iqty-main {
  background: var(--c7-surf);
  border: 2px solid var(--c7-border2);
  color: var(--c7-text);
}
.mp-iqty-of {
  background: var(--c7-surf3);
  border: 2px dashed var(--c7-border2);
  color: var(--c7-muted2);
}
.mp-iqty-sep {
  font-family: var(--c7-mono); font-size: 40px; font-weight: 800;
  color: var(--c7-muted2);
}
.mp-item.done  .mp-iqty-main { color: var(--c7-green); border-color: var(--c7-green); }
.mp-item.partial .mp-iqty-main { color: var(--c7-amber); border-color: var(--c7-amber); }
.mp-undo {
  font-size: 15px; font-weight: 600; background: none;
  border: 1px solid var(--c7-border2); color: var(--c7-muted2);
  border-radius: 3px; padding: 3px 8px; cursor: pointer;
  font-family: var(--c7-font);
  transition: all .1s;
}
.mp-undo:hover { border-color: var(--c7-red); color: var(--c7-red); }
.mp-locked-label {
  display: inline-block; margin-top: 4px; padding: 2px 8px;
  font-size: 11px; font-weight: 700; letter-spacing: .3px;
  color: #8a6d1a; background: #fdf6e0; border: 1px solid #e8d48a;
  border-radius: 4px; cursor: default; white-space: nowrap;
}

/* Verified banner overlay */
.mp-item.done .mp-verified-label {
  display: flex;
}
.mp-verified-label {
  display: none;
  position: absolute;
  top: 6px; right: 8px;
  background: var(--c7-green);
  color: #fff; font-size: 14px; font-weight: 700;
  letter-spacing: 0.8px; text-transform: uppercase;
  padding: 2px 8px; border-radius: 10px;
}

/* Flash animations */
@keyframes fG {
  0%   { background: rgba(16,185,129,0.15); }
  25%  { background: rgba(16,185,129,0.55); border-left-color: #4f9c2f; }
  100% { background: rgba(16,185,129,0.12); border-left-color: #79c447; }
}
@keyframes fA {
  0%   { background: rgba(245,158,11,0.05); }
  30%  { background: rgba(245,158,11,0.25); }
  100% { background: rgba(245,158,11,0.08); }
}
.mp-item.fG { animation: fG .5s ease forwards; }
.mp-item.fA { animation: fA .4s ease; }

/* ══ EMPTY STATE ══ */
.mp-empty {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  flex: 1; padding: 60px 20px;
  color: var(--c7-muted); text-align: center; gap: 10px;
  height: 100%;
}
.mp-empty .ico { font-size: 52px; opacity: .2; }
.mp-empty .t   { font-size: 20px; font-weight: 600; color: var(--c7-text); }
.mp-empty .s   { font-size: 17px; color: var(--c7-muted); }

/* ══ REPRINT BUTTON — inline in titlebar ══ */
.mp-reprint-btn {
  background: var(--c7-surf3);
  border: 1px solid var(--c7-border2);
  border-radius: var(--c7-r);
  color: var(--c7-muted);
  font-family: var(--c7-font); font-size: 16px; font-weight: 600;
  padding: 0 14px; height: 30px;
  cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  transition: background .1s, color .1s, border-color .1s;
  white-space: nowrap; flex-shrink: 0; margin-right: 10px;
}
.mp-reprint-btn:hover:not(:disabled) {
  background: #eef9fd; border-color: var(--c7-teal); color: var(--c7-teal);
}
.mp-reprint-btn:disabled { opacity: .4; cursor: not-allowed; }
.mp-reprint-btn.active { color: var(--c7-teal); border-color: var(--c7-teal); }

/* ══ UNASSIGN JOB BUTTON — inline in tabChip ══ */
.mp-unassign-btn {
  display: inline-flex; align-items: center; gap: 5px;
  margin-left: 8px;
  background: var(--c7-surf3);
  border: 1px solid var(--c7-border2);
  border-radius: var(--c7-r);
  color: var(--c7-muted);
  font-family: var(--c7-font); font-size: 16px; font-weight: 600;
  padding: 0 12px; height: 26px;
  cursor: pointer; white-space: nowrap; flex-shrink: 0;
  transition: background .1s, color .1s, border-color .1s;
}
.mp-unassign-btn:hover:not(:disabled) {
  background: #fff0f0; border-color: var(--c7-red); color: var(--c7-red);
}
.mp-unassign-btn:disabled { opacity: .35; cursor: not-allowed; }
/* Alert state — pulsing amber border when job is blocking a load */
.mp-unassign-btn.mp-unassign-alert {
  border-color: var(--c7-amber); color: var(--c7-amber);
  background: var(--c7-amber-bg);
  animation: mpUnassignPulse 1.5s ease-in-out infinite;
}
@keyframes mpUnassignPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
  50%       { box-shadow: 0 0 0 4px rgba(245,158,11,0.25); }
}

.mp-retain-wrap {
  display: flex; align-items: center; gap: 7px;
  margin-top: 10px; padding: 8px 10px;
  background: var(--c7-surf3); border: 1px solid var(--c7-border);
  border-radius: var(--c7-r); cursor: pointer; user-select: none;
}
.mp-retain-wrap input[type=checkbox] {
  width: 15px; height: 15px; accent-color: var(--c7-teal);
  cursor: pointer; flex-shrink: 0; margin: 0;
}
.mp-retain-label {
  font-size: 16px; color: var(--c7-muted); font-family: var(--c7-font);
  line-height: 1.3;
}
.mp-retain-wrap:has(input:checked) { border-color: var(--c7-teal); background: #eef9fd; }
.mp-retain-wrap:has(input:checked) .mp-retain-label { color: var(--c7-teal); }

/* ══ DETAIL COUNTER PILL — inline in titlebar tabChip ══ */
.mp-dc-pill {
  display: inline-flex; align-items: center; gap: 6px;
  margin-left: 12px;
  background: var(--c7-surf3); border: 1px solid var(--c7-border2);
  border-radius: 20px; padding: 0 12px; height: 26px;
  cursor: pointer; user-select: none; flex-shrink: 0;
  transition: border-color .12s, background .12s;
}
.mp-dc-pill:hover { border-color: var(--c7-teal); background: #eef9fd; }
.mp-dc-pill-total {
  font-family: var(--c7-mono); font-size: 17px; font-weight: 700;
  color: var(--c7-amber);
  transition: color .2s;
}
.mp-dc-pill-total.zero { color: var(--c7-green); }
.mp-dc-pill-label {
  font-size: 15px; font-weight: 500; color: var(--c7-muted);
  text-transform: uppercase; letter-spacing: .5px;
}

/* ══ DETAIL COUNTER POPOVER — drops below titlebar on pill click ══ */
.mp-dc-popover {
  position: absolute;
  top: 44px; left: 0;           /* flush under the titlebar, left-aligned */
  z-index: 500;
  width: 260px;
  background: var(--c7-surf);
  border: 1px solid var(--c7-border2);
  border-top: none;
  border-radius: 0 0 var(--c7-r) var(--c7-r);
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
  overflow: hidden;
}
.mp-dc-pop-title {
  padding: 8px 12px;
  background: var(--c7-surf2);
  border-bottom: 1px solid var(--c7-border);
  font-size: 14px; font-weight: 700; letter-spacing: 1px;
  text-transform: uppercase; color: var(--c7-muted);
}
.mp-dc-body { max-height: 260px; overflow-y: auto; }
.mp-dc-body::-webkit-scrollbar { width: 4px; }
.mp-dc-body::-webkit-scrollbar-thumb { background: var(--c7-border2); border-radius: 2px; }
.mp-dc-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--c7-border);
  font-size: 16px;
}
.mp-dc-row:last-child { border-bottom: none; }
.mp-dc-row-sku {
  font-family: var(--c7-mono); font-weight: 600;
  color: var(--c7-text); min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1; margin-right: 10px;
}
.mp-dc-row-qty {
  font-family: var(--c7-mono); font-size: 17px; font-weight: 700;
  color: var(--c7-amber); flex-shrink: 0; min-width: 28px; text-align: right;
}
.mp-dc-row-qty.done { color: var(--c7-green); }
.mp-dc-row.all-done { opacity: .55; }

/* ══ MULTI-TOTE AWARENESS MODAL ══ */
.mp-multitote-overlay {
  position: fixed; inset: 0; z-index: 9998;
  background: rgba(0,0,0,.6);
  animation: fadeIn .15s ease;
}
.mp-multitote-modal {
  position: fixed;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%) scale(0.92);
  z-index: 9999;
  background: var(--c7-surf);
  border: 2px solid var(--c7-amber);
  border-radius: 12px;
  padding: 44px 52px;
  min-width: 520px; max-width: 640px; width: 100%;
  box-shadow: 0 32px 80px rgba(0,0,0,.75);
  animation: mpPopIn .2s cubic-bezier(.34,1.56,.64,1) forwards;
  font-family: var(--c7-font);
}
.mp-multitote-icon {
  font-size: 52px; line-height: 1; margin-bottom: 14px; text-align: center;
}
.mp-multitote-title {
  font-size: 30px; font-weight: 800; color: var(--c7-amber);
  margin-bottom: 8px; text-align: center;
}
.mp-multitote-sub {
  font-size: 18px; color: var(--c7-muted); margin-bottom: 22px; text-align: center;
  line-height: 1.4;
}
.mp-multitote-list {
  background: var(--c7-bg); border: 1px solid var(--c7-border2);
  border-radius: var(--c7-r); padding: 6px 18px;
  margin-bottom: 28px;
  display: flex; flex-direction: column; gap: 0;
}
.mp-multitote-list-item {
  display: flex; align-items: center; gap: 14px;
  font-size: 19px; color: var(--c7-text);
  padding: 12px 0; border-bottom: 1px solid var(--c7-border);
}
.mp-multitote-list-item:last-child { border-bottom: none; }
.mp-multitote-list-item .mt-idx {
  font-family: var(--c7-mono); font-size: 15px; font-weight: 700;
  color: var(--c7-muted2); min-width: 28px;
}
.mp-multitote-list-item .mt-no {
  font-family: var(--c7-mono); font-size: 26px; font-weight: 800;
  color: var(--c7-teal); letter-spacing: .5px;
}
.mp-multitote-list-item .mt-cur {
  margin-left: auto; font-size: 14px; font-weight: 800;
  color: var(--c7-green); letter-spacing: 1px; text-transform: uppercase;
}
.mp-multitote-confirm {
  width: 100%; background: var(--c7-amber); color: #173140;
  border: none; border-radius: var(--c7-r);
  padding: 18px 0; font-size: 22px; font-weight: 800;
  cursor: pointer; font-family: var(--c7-font);
  transition: background .1s; letter-spacing: .5px;
}
.mp-multitote-confirm:hover { background: #e8a824; }

/* ══ EMPTY CONTAINER POPUP ══ */
.mp-empty-popup {
  position: fixed;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%) scale(0.92);
  z-index: 9999;
  background: var(--c7-surf);
  border: 2px solid var(--c7-green);
  border-radius: 12px;
  padding: 40px 48px;
  text-align: center;
  box-shadow: 0 24px 64px rgba(0,0,0,.7);
  animation: mpPopIn .2s cubic-bezier(.34,1.56,.64,1) forwards;
  min-width: 320px;
}
@keyframes mpPopIn {
  from { opacity: 0; transform: translate(-50%,-50%) scale(0.85); }
  to   { opacity: 1; transform: translate(-50%,-50%) scale(1); }
}
.mp-empty-popup-icon { font-size: 60px; line-height: 1; margin-bottom: 12px; }
.mp-empty-popup-title {
  font-size: 28px; font-weight: 800; color: var(--c7-green);
  margin-bottom: 6px; font-family: var(--c7-font);
}
.mp-empty-popup-sub {
  font-size: 18px; color: var(--c7-muted); margin-bottom: 24px;
  font-family: var(--c7-font);
}
.mp-empty-popup-dismiss {
  background: var(--c7-green); color: #fff;
  border: none; border-radius: var(--c7-r);
  padding: 12px 32px; font-size: 19px; font-weight: 700;
  cursor: pointer; font-family: var(--c7-font);
  transition: background .1s;
}
.mp-empty-popup-dismiss:hover { background: #5aa632; }
.mp-popup-overlay {
  position: fixed; inset: 0; z-index: 9998;
  background: rgba(0,0,0,.55);
  animation: fadeIn .15s ease;
}
@keyframes fadeIn { from { opacity:0; } to { opacity:1; } }

#mp-tab-close {
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
  background: transparent !important;
  border: 0 !important;
  color: inherit !important;
  font-size: inherit;
  line-height: inherit;
  text-decoration: none !important;
  margin-left: 4px;
  padding: 0;
  vertical-align: middle;
  flex-shrink: 0;
  opacity: .7;
}
#mp-tab-close:hover {
  background: transparent !important;
  color: inherit !important;
  opacity: 1;
}
#mp-tab-close i.icon-close { display: inline-block; }

/* ══ EVENT CONSOLE PILL + DROPDOWN ══ */
.mp-log-pill {
  display: inline-flex; align-items: center; gap: 8px;
  height: 26px; padding: 0 12px;
  border-radius: 20px; border: 1px solid var(--c7-border2);
  background: var(--c7-surf3);
  font-family: var(--c7-mono); font-size: 13px; font-weight: 700;
  cursor: pointer; user-select: none;
  flex: 1; min-width: 0; /* grow to fill space between unassign and reprint */
  transition: border-color .12s, background .12s;
  margin: 0 12px;
}
.mp-log-pill:hover { border-color: var(--c7-teal); background: #eef9fd; }
.mp-log-pill-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--c7-muted2);
  transition: background .2s;
}
.mp-log-pill-dot.ok  { background: var(--c7-green); }
.mp-log-pill-dot.err { background: var(--c7-red); }
.mp-log-pill-label {
  color: var(--c7-muted2); font-size: 13px; letter-spacing: .3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1; min-width: 0;
}
.mp-log-pill-label.ok  { color: var(--c7-green); }
.mp-log-pill-label.err { color: var(--c7-red); }
.mp-log-pill-arr {
  font-size: 11px; color: var(--c7-muted2); flex-shrink: 0; margin-left: 2px;
  transition: transform .15s;
}
.mp-log-pill.open .mp-log-pill-arr { transform: rotate(180deg); }

/* ══ PICKER BADGE — sits right of the console label, left of the arrow ══ */
.mp-log-pill-picker {
  display: inline-flex; align-items: center;
  flex-shrink: 0;
  font-size: 12px; font-weight: 600;
  color: var(--c7-teal);
  background: rgba(34,211,238,.10);
  border: 1px solid rgba(34,211,238,.25);
  border-radius: 10px;
  padding: 0 7px; height: 18px;
  white-space: nowrap;
  margin-left: 4px;
}

/* ══ SHIPMENT BADGE — persistent shipment number in titlebar ══ */
.mp-ship-badge {
  display: inline-flex; align-items: center;
  flex-shrink: 0;
  font-size: 12px; font-weight: 600;
  color: var(--c7-muted2);
  background: rgba(255,255,255,.06);
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 10px;
  padding: 0 8px; height: 20px;
  white-space: nowrap;
  margin-left: 6px;
  cursor: default;
}
.mp-ship-badge::before { content: '📦 '; font-size: 11px; margin-right: 3px; }
.mp-ship-badge.mp-ship-badge--error {
  color: var(--mp-red, #f87171);
  border-color: rgba(248,113,113,.35);
  background: rgba(248,113,113,.10);
}

.mp-log-popover {
  position: absolute;
  top: 44px; right: 0;
  z-index: 500;
  width: 420px;
  background: var(--c7-surf);
  border: 1px solid var(--c7-border2);
  border-top: none;
  border-radius: 0 0 var(--c7-r) var(--c7-r);
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
  overflow: hidden;
  display: none;
}
.mp-log-pop-title {
  padding: 8px 12px;
  background: var(--c7-surf2);
  border-bottom: 1px solid var(--c7-border);
  font-size: 13px; font-weight: 700; letter-spacing: 1px;
  text-transform: uppercase; color: var(--c7-muted);
  display: flex; align-items: center; justify-content: space-between;
}
.mp-log-pop-clear {
  font-size: 12px; font-weight: 600; color: var(--c7-muted2);
  cursor: pointer; letter-spacing: 0; text-transform: none;
  background: none; border: none; padding: 0;
  font-family: var(--c7-font);
}
.mp-log-pop-clear:hover { color: var(--c7-red); }
.mp-log-body {
  max-height: 280px; overflow-y: auto;
}
.mp-log-body::-webkit-scrollbar { width: 4px; }
.mp-log-body::-webkit-scrollbar-thumb { background: var(--c7-border2); border-radius: 2px; }
.mp-log-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--c7-border);
  font-size: 14px;
}
.mp-log-row:last-child { border-bottom: none; }
.mp-log-row-dot {
  width: 7px; height: 7px; border-radius: 50%;
  flex-shrink: 0; margin-top: 4px;
}
.mp-log-row-dot.ok  { background: var(--c7-green); }
.mp-log-row-dot.err { background: var(--c7-red); }
.mp-log-row-msg {
  font-family: var(--c7-font); color: var(--c7-text);
  flex: 1; line-height: 1.4; word-break: break-word;
}
.mp-log-row-msg.err { color: var(--c7-red); }
.mp-log-row-msg.ok  { color: var(--c7-text); }
.mp-log-row-time {
  font-family: var(--c7-mono); font-size: 12px;
  color: var(--c7-muted2); flex-shrink: 0; margin-top: 2px;
}
.mp-log-empty {
  padding: 16px 12px; font-size: 14px;
  color: var(--c7-muted); text-align: center;
  font-family: var(--c7-font);
}

/* ══ NAV ITEM (first position in C7 sidebar) ══ */
#mp-nav-li { order: -1; }
#mp-nav {
  display: flex !important; align-items: center;
  gap: 10px; padding: 10px 12px;
  color: #fabb3d !important; font-weight: 500;
  cursor: pointer; transition: background .1s;
  text-decoration: none !important;
  position: relative;
}
#mp-nav:hover { background: rgba(245,158,11,.08); }
#mp-nav .mp-nav-icon {
  width: 20px; height: 20px; flex-shrink: 0;
  background: transparent; border-radius: 4px; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
}
#mp-nav .mp-nav-icon img { width: 20px; height: 20px; object-fit: contain; border-radius: 4px; }
#mp-nav .mp-nav-label { font-size: 17px; font-weight: 500; }
#mp-nav .mp-nav-badge { display: none; }

/* ══ FINALISING / PRINTING LOCK OVERLAY ══ */
.mp-finalise-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, .30);
  backdrop-filter: blur(2px);
  pointer-events: all;
}
#mp-tab-view.finalising .mp-layout,
#mp-tab-view.finalising .mp-foot {
  filter: blur(1.5px);
  opacity: .55;
}
#mp-tab-view.finalising .mp-finalise-overlay { display: flex; }
.mp-finalise-card {
  min-width: 280px;
  padding: 22px 24px;
  border: 1px solid var(--c7-border2);
  border-radius: 8px;
  background: var(--c7-surf);
  color: var(--c7-text);
  box-shadow: 0 16px 50px rgba(0,0,0,.35);
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 18px;
  font-weight: 700;
}
.mp-finalise-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--c7-border2);
  border-top-color: var(--c7-amber);
  border-radius: 50%;
  animation: mpSpin .75s linear infinite;
}
@keyframes mpSpin { to { transform: rotate(360deg); } }

/* ══ FOOTER STATUS BAR ══ */
.mp-foot {
  background: var(--c7-surf);
  border-top: 1px solid var(--c7-border);
  padding: 0 20px; height: 36px;
  display: flex; align-items: center; gap: 20px;
  flex-shrink: 0;
}
.mp-fi { font-size: 15px; color: var(--c7-muted); display: flex; align-items: center; gap: 4px; }
.mp-fi strong { color: var(--c7-text); font-weight: 600; font-family: var(--c7-mono); font-size: 15px; }
.mp-fi-sep { color: var(--c7-border2); }

/* ══ COLLAPSIBLE SHIPMENT CARD ══ */
.mp-ship-toggle {
  width: 100%; background: var(--c7-bg); border: 1px solid var(--c7-border2);
  border-radius: var(--c7-r); color: var(--c7-text);
  font-family: var(--c7-font); font-size: 15px; font-weight: 800;
  text-transform: uppercase; letter-spacing: 1px;
  padding: 10px 12px; cursor: pointer;
  display: flex; align-items: center; justify-content: space-between;
}
.mp-ship-toggle:hover { border-color: var(--c7-teal); }
.mp-ship-toggle .arr { transition: transform .15s; color: var(--c7-muted); }
.mp-ship-card.open .mp-ship-toggle .arr { transform: rotate(180deg); }
.mp-ship-body { display: none; margin-top: 10px; }
.mp-ship-card.open .mp-ship-body { display: block; }
</style>`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 8.  DOM HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'cls') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (typeof kid === 'string') el.append(kid);
      else if (kid) el.append(kid);
    }
    return el;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 9.  UI REFS & BUILD
  // ─────────────────────────────────────────────────────────────────────────────

  let R = {}; // live DOM refs
  let _queuePollInterval = null;
  let _autoReloadAfterClose = false;
  let _autoLoadInFlight = false;

  /**
   * Measure the actual Canary7 content area from the DOM and position
   * the tab view to fill it exactly — works regardless of C7 version/layout.
   * Falls back to sidebar-width + header-height heuristics if DOM measurement fails.
   */
  function positionTabView(view) {
    const sidebar = document.querySelector('div.sidebar, .sidebar');
    const tabBar  = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    let top = 56, left = 200;
    if (sidebar) { const r = sidebar.getBoundingClientRect(); left = Math.round(r.right); }
    if (tabBar)  { const r = tabBar.getBoundingClientRect();  top  = Math.round(r.bottom); }
    view.style.top    = top  + 'px';
    view.style.left   = left + 'px';
    view.style.right  = '0px';
    view.style.bottom = '0px';
  }

  function buildUI() {
    // Always start Malpa Pack clean. Native C7 can leave retained source tote
    // state checked/preloaded after refresh; this script should not inherit it.
    resetRetainedToteState();

    // Find the native C7 tab bar
    const tabBar = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    if (!tabBar) {
      console.error('[MalpaPack] Cannot find C7 tab bar');
      return;
    }

    // ── Inject native tab chip into C7 tab bar ────────────────────────────
    const _logoUrl = 'data:image/png;base64,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';

    const tabLi = document.createElement('li');
    tabLi.id        = 'mp-tab-li';
    tabLi.className = 'nav-item ng-star-inserted active';

    // Build with createElement — browsers strip nested <a> inside <a> when using
    // innerHTML, but Angular's own tabs use this structure. createElement bypasses
    // the browser's HTML parser sanitisation.
    const tabA = document.createElement('a');
    tabA.className = 'nav-link active';
    tabA.href = 'javascript:void(0);';
    tabA.setAttribute('role', 'tab');
    tabA.setAttribute('aria-selected', 'true');

    const tabSpan = document.createElement('span');

    const tabDdWrap = document.createElement('div');
    tabDdWrap.className = 'dropdown inherit-dropdown d-inline-block ng-star-inserted';
    const tabDd = document.createElement('div');
    tabDd.setAttribute('aria-expanded', 'false');
    tabDd.setAttribute('aria-haspopup', 'true');
    tabDd.className = 'tab-dropdown';
    const tabImg = document.createElement('img');
    tabImg.src = _logoUrl;
    tabImg.style.cssText = 'width:14px;height:14px;border-radius:3px;object-fit:cover;vertical-align:middle;margin-right:4px';
    tabImg.onerror = () => tabImg.style.display = 'none';
    tabDd.appendChild(tabImg);
    tabDd.appendChild(document.createTextNode('Malpa Pack \u00a0'));
    tabDdWrap.appendChild(tabDd);

    // Close button — sibling of the dropdown, inside nav-link (matches C7 exactly)
    const tabClose = document.createElement('a');
    tabClose.id        = 'mp-tab-close';
    tabClose.className = 'ng-star-inserted';
    tabClose.href      = 'javascript:void(0);';
    // i.icon-close is hidden by CSS; ::after renders the × character
    const tabCloseI = document.createElement('i');
    tabCloseI.className = 'icon-close';
    tabClose.appendChild(tabCloseI);

    tabA.appendChild(tabSpan);
    tabA.appendChild(tabDdWrap);
    tabA.appendChild(tabClose);
    tabLi.appendChild(tabA);

    // ── Tab switching logic ───────────────────────────────────────────────
    // Two mechanisms working together:
    // 1. Direct click on our tab → show view
    // 2. Direct click on another C7 tab → hide view immediately
    // 3. Poll checks if our li was REMOVED by Angular navigation → hide view
    //    (does NOT check active class — that would fight other-tab clicks)

    let _mpViewVisible = true; // track our intended state

    function activateMalpaTab() {
      tabBar.querySelectorAll('li.nav-item').forEach(li => {
        if (li.id !== 'mp-tab-li') {
          li.classList.remove('active');
          const a = li.querySelector('a.nav-link');
          if (a) { a.classList.remove('active'); a.setAttribute('aria-selected','false'); }
        }
      });
      tabLi.classList.add('active');
      tabA.classList.add('active');
      tabA.setAttribute('aria-selected','true');
      const mpView = document.getElementById('mp-tab-view');
      if (mpView) mpView.style.display = 'flex';
      _mpViewVisible = true;
    }

    // Our tab clicked
    tabA.addEventListener('click', (e) => {
      e.preventDefault();
      activateMalpaTab();
    });

    // Close button clicked
    tabClose.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeUI();
    });


    // Any other C7 tab clicked → hide our view immediately
    tabBar.addEventListener('click', (e) => {
      const li = e.target.closest('li.nav-item');
      if (li && li.id !== 'mp-tab-li') {
        const mpView = document.getElementById('mp-tab-view');
        if (mpView) mpView.style.display = 'none';
        tabLi.classList.remove('active');
        tabA.classList.remove('active');
        tabA.setAttribute('aria-selected', 'false');
        _mpViewVisible = false;
      }
    }, true);

    // Sidebar nav click → C7 opens a new tab and switches to it.
    // We need to hide our view when the sidebar is clicked (any item).
    const sidebar = document.querySelector('div.sidebar, .sidebar, nav.sidebar');
    if (sidebar) {
      sidebar.addEventListener('click', (e) => {
        const mpView = document.getElementById('mp-tab-view');
        if (!mpView) return;
        // Only hide if the click is on a nav link (not search, not our item)
        const navLink = e.target.closest('a.nav-link, li.nav-item');
        if (navLink && navLink.id !== 'mp-nav' && !navLink.contains(document.getElementById('mp-nav'))) {
          mpView.style.display = 'none';
          tabLi.classList.remove('active');
          tabA.classList.remove('active');
          tabA.setAttribute('aria-selected', 'false');
          _mpViewVisible = false;
        }
      }, true);
    }

    // Poll checks two things:
    // 1. If our li was REMOVED by Angular navigation → hide view
    // 2. If another tab became active (C7 gave it active class) → hide our view
    //    This handles sidebar-opened tabs that Angular activates directly
    window._mpTabPoll = setInterval(() => {
      const mpView = document.getElementById('mp-tab-view');
      if (!mpView) { clearInterval(window._mpTabPoll); return; }
      const mpLi = document.getElementById('mp-tab-li');
      if (!mpLi) {
        mpView.style.display = 'none';
        _mpViewVisible = false;
        return;
      }
      // Check if C7 activated another tab (Angular router added active to a different li)
      if (_mpViewVisible) {
        const anotherActive = tabBar.querySelector('li.nav-item.active:not(#mp-tab-li)');
        if (anotherActive) {
          mpView.style.display = 'none';
          tabLi.classList.remove('active');
          tabA.classList.remove('active');
          tabA.setAttribute('aria-selected', 'false');
          _mpViewVisible = false;
        }
      }
    }, 200);

    tabBar.appendChild(tabLi);

    // ── Main view — fixed positioned, covers C7 content area ──────────────
    const view = h('div', { id: 'mp-tab-view' });
    view.style.cssText = 'display:flex;flex-direction:column;';

    // ── Titlebar with queue badge ─────────────────────────────────────────
    const titlebar   = h('div', { cls: 'mp-titlebar' });
    const tabChip    = h('div', { cls: 'mp-titlebar-tab' });
    const queueBadge = h('span', { cls: 'mp-titlebar-queue', style: 'display:none' }, 'QUEUE 0');
    tabChip.append(
      (() => {
        const ic = h('span', { cls: 'mp-titlebar-icon' });
        const im = document.createElement('img');
        im.src = 'data:image/png;base64,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';
        im.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:4px';
        im.onerror = () => { ic.innerHTML = ''; const fb = document.createElement('span'); fb.className = 'mp-titlebar-icon-fb'; fb.textContent = 'M'; ic.append(fb); };
        ic.append(im); return ic;
      })(),
      h('span', { cls: 'mp-titlebar-name' }, 'Malpa Pack'),
    );

    // ── Detail counter pill — sits in tabChip, right of "Malpa Pack" ─────
    // Hidden until a container is loaded. Click opens a dropdown popover.
    const dcPill = h('div', { cls: 'mp-dc-pill', style: 'display:none' });
    const dcPillTotal = h('span', { cls: 'mp-dc-pill-total' }, '0');
    const dcPillLabel = h('span', { cls: 'mp-dc-pill-label' }, 'Lines to Pack');
    dcPill.append(dcPillTotal, dcPillLabel);

    // Popover — drops below the titlebar, aligned to pill
    const dcPopover = h('div', { cls: 'mp-dc-popover', style: 'display:none' });
    const dcPopoverTitle = h('div', { cls: 'mp-dc-pop-title' }, 'Details in Container');
    const dcBody = h('div', { cls: 'mp-dc-body' });
    dcPopover.append(dcPopoverTitle, dcBody);

    // Alias dcTotal → dcPillTotal for updateDetailCounter compatibility
    const dcTotal = dcPillTotal;
    const dcPanel = dcPill; // used by hide/show logic in reset functions

    // Toggle popover on pill click
    dcPill.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dcPopover.style.display !== 'none';
      dcPopover.style.display = isOpen ? 'none' : '';
    });
    // Close popover on outside click
    document.addEventListener('click', () => { dcPopover.style.display = 'none'; });

    tabChip.append(dcPill);

    // ── Unassign Job button — sits in tabChip, right of detail pill ───────
    // Enabled when a job_id is known (from successful GPC or from job lookup on error).
    const unassignBtn = h('button', { cls: 'mp-unassign-btn' }, '⛔ Unassign Job');
    unassignBtn.disabled = true;
    unassignBtn.title = 'Enter a tote number, then click to unassign its job';
    unassignBtn.addEventListener('click', async () => {
      unassignBtn.disabled = true;

      try {
        // Resolve job_id — use cached value if available, otherwise look up from tote input
        let jobId = _currentJobId;
        if (!jobId) {
          const containerNo = R.toteIn?.value?.trim();
          if (!containerNo) {
            setStatus('Enter a tote number first, then click Unassign Job.', 'warn');
            unassignBtn.disabled = false;
            return;
          }
          unassignBtn.textContent = '⛔ Looking up job…';
          setStatus(`Looking up job for container ${containerNo}…`, 'loading');
          jobId = await fetchJobIdByContainer(containerNo);
          _currentJobId = jobId;
        }

        unassignBtn.textContent = '⛔ Unassigning…';
        setStatus(`Unassigning job ${jobId}…`, 'loading');
        await unassignJob(jobId);

        _currentJobId = null;
        unassignBtn.classList.remove('mp-unassign-alert');
        unassignBtn.textContent = '✓ Job Unassigned';
        unassignBtn.title = 'Job unassigned — click Load to proceed';
        setStatus(`Job ${jobId} unassigned — click Load to proceed.`, 'ok');
        EventLog.ok(`Job ${jobId} unassigned successfully.`);
        beep('ok');
        // Re-focus tote input so operator can immediately hit Load
        setTimeout(() => {
          unassignBtn.textContent = '⛔ Unassign Job';
          unassignBtn.disabled = false;
          R.toteIn && R.toteIn.focus();
        }, 1500);

      } catch (err) {
        unassignBtn.textContent = '⛔ Unassign Failed';
        setStatus(`Unassign error: ${err.message}`, 'err');
        EventLog.err(`Unassign job failed: ${err.message}`);
        beep('err');
        setTimeout(() => {
          unassignBtn.textContent = '⛔ Unassign Job';
          unassignBtn.disabled = false;
        }, 2500);
      }
    });
    tabChip.append(unassignBtn);

    // Popover is appended to view after view is created (needs to be outside tabChip flow)
    // ── Shipment number badge — persistent in titlebar for troubleshooting ──
    // Shows the shipment number of the last loaded tote. Stays visible after
    // the order completes so operators can look up the shipment if a label
    // failed or a consign error occurred.
    const shipBadge = h('span', { cls: 'mp-ship-badge', id: 'mp-ship-badge', title: 'Last shipment scanned' }, '—');

    // ── Reprint Label button — inline in titlebar, right of spacer ───────
    const reprintBtn = h('button', { cls: 'mp-reprint-btn' }, '🖨 Reprint Last Label');
    reprintBtn.disabled = true;
    reprintBtn.title = 'No label to reprint yet — complete a consignment first';
    reprintBtn.addEventListener('click', async () => {
      if (!_lastConsignmentId) return;
      reprintBtn.disabled = true;
      reprintBtn.textContent = '🖨 Reprinting…';
      try {
        await reprintLabel(_lastConsignmentId);
        reprintBtn.textContent = '✓ Sent to Printer';
        reprintBtn.classList.add('active');
        setTimeout(() => {
          reprintBtn.textContent = '🖨 Reprint Last Label';
          reprintBtn.classList.remove('active');
          reprintBtn.disabled = false;
        }, 2000);
      } catch (err) {
        reprintBtn.textContent = '✕ Reprint Failed';
        setTimeout(() => {
          reprintBtn.textContent = '🖨 Reprint Last Label';
          reprintBtn.disabled = false;
        }, 2500);
      }
    });

    // ── Event Console pill — sits between spacer and reprint button ──────
    const logPill   = h('div', { cls: 'mp-log-pill', id: 'mp-log-pill' });
    const logDot    = h('div', { cls: 'mp-log-pill-dot', id: 'mp-log-dot' });
    const logLbl    = h('div', { cls: 'mp-log-pill-label', id: 'mp-log-label' }, 'Console');
    const pickerBadge = h('span', { cls: 'mp-log-pill-picker', id: 'mp-picker-badge', style: 'display:none' });
    const logArr    = h('span', { cls: 'mp-log-pill-arr' }, '▼');
    logPill.append(logDot, logLbl, pickerBadge, logArr);

    const logPopover = h('div', { cls: 'mp-log-popover', id: 'mp-log-popover' });
    const logPopTitle = h('div', { cls: 'mp-log-pop-title' });
    logPopTitle.append(
      document.createTextNode('Event Console'),
    );
    const logClearBtn = h('button', { cls: 'mp-log-pop-clear' }, 'Clear');
    logPopTitle.append(logClearBtn);
    const logBody = h('div', { cls: 'mp-log-body', id: 'mp-log-body' });
    logBody.append(h('div', { cls: 'mp-log-empty' }, 'No events yet this shipment.'));
    logPopover.append(logPopTitle, logBody);

    // Toggle popover on pill click; lazy-render entries each open
    logPill.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = logPopover.style.display === 'block';
      logPopover.style.display = open ? 'none' : 'block';
      logPill.classList.toggle('open', !open);
      if (!open) EventLog._renderInto(logBody);
    });
    logClearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      EventLog.clear();
    });
    // Close on outside click — deferred so the pill's own click doesn't immediately close it
    document.addEventListener('click', (e) => {
      if (!logPill.contains(e.target) && !logPopover.contains(e.target)) {
        logPopover.style.display = 'none';
        logPill.classList.remove('open');
      }
    });

    titlebar.append(tabChip, logPill, shipBadge, reprintBtn);
    view.append(titlebar);
    view.append(dcPopover); // popover sits outside tabChip so it can overflow below titlebar
    view.append(logPopover); // log popover also outside tabChip, right-aligned

    // ── Layout: left panel + right panel ──────────────────────────────────
    const layout = h('div', { cls: 'mp-layout' });

    // ════════════ LEFT PANEL ═════════════════════════════════════════════

    const left = h('div', { cls: 'mp-left' });

    // ── Profile section ──────────────────────────────────────────────────
    const profSection = h('div', { cls: 'mp-section' });
    const profLbl     = h('label', { cls: 'mp-lbl' }, 'Packing Profile');
    const profDd      = h('div', { cls: 'mp-dd' });
    const profBtn     = h('div', { cls: 'mp-dd-btn', tabindex: '0' });
    const profBtnTxt  = h('span', {}, 'Loading profiles…');
    const profBtnArr  = h('span', { cls: 'arr' }, '▼');
    profBtn.append(profBtnTxt, profBtnArr);
    const profList = h('div', { cls: 'mp-dd-list', style: 'display:none' });
    profDd.append(profBtn, profList);
    const profSel = {
      _profiles: [], _value: '', _btn: profBtn, _btnTxt: profBtnTxt, _list: profList,
      get value() { return this._value; },
      set disabled(v) {
        profBtn.style.opacity = v ? '.5' : '';
        profBtn.style.pointerEvents = v ? 'none' : '';
      },
      get disabled() { return profBtn.style.pointerEvents === 'none'; },
      innerHTML: '',
    };
    profSection.append(profLbl, profDd);

    // ── Location section ─────────────────────────────────────────────────
    const locSection = h('div', { cls: 'mp-section' });
    // Declare always so R refs never throw ReferenceError
    let locIn = null, locBtn = null, locGrp = null;
    // When auto-set: render compactly at top as a confirmation strip, not a form
    if (_preloadedLocationId) {
      locSection.style.cssText = 'padding:8px 16px;border-bottom:1px solid var(--c7-border);background:rgba(16,185,129,0.06);flex-shrink:0';
      const locConfirm = h('div', {}, '');
      locConfirm.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:16px;color:var(--c7-muted)';
      locConfirm.innerHTML = `<span style="color:var(--c7-green);font-size:18px">✓</span> Pack location <strong style="color:var(--c7-text);font-family:var(--c7-mono)">${_preloadedLocation}</strong> <span style="margin-left:auto;font-size:14px;color:var(--c7-muted2);cursor:pointer" id="mp-loc-edit">change</span>`;
      locSection.appendChild(locConfirm);
      // "change" link restores the full input
      setTimeout(() => {
        const editLink = document.getElementById('mp-loc-edit');
        if (editLink) editLink.addEventListener('click', () => {
          locSection.style.cssText = 'padding:14px 16px;border-bottom:1px solid var(--c7-border);flex-shrink:0';
          locSection.innerHTML = '';
          const lbl2 = h('label', { cls: 'mp-lbl' }, 'Pack-To Location');
          const grp2 = h('div', { cls: 'mp-sg' });
          const in2  = h('input', { cls: 'mp-si', type: 'text', value: _preloadedLocation || '', autocomplete: 'off' });
          const btn2 = h('button', { cls: 'mp-sb' }, 'Set');
          btn2.addEventListener('click', () => onSetLocation(in2.value.trim()));
          in2.addEventListener('keydown', e => { if (e.key === 'Enter') onSetLocation(in2.value.trim()); });
          grp2.append(in2, btn2);
          locSection.append(lbl2, grp2);
          R.locIn = in2; R.locBtn = btn2; R.locGrp = grp2;
          in2.focus();
        });
      }, 200);
    } else {
      // Not auto-set — show full input form
      const locLbl  = h('label', { cls: 'mp-lbl' }, 'Pack-To Location');
      locGrp  = h('div', { cls: 'mp-sg' });
      locIn   = h('input', { cls: 'mp-si', type: 'text', placeholder: 'e.g. WDD-01', autocomplete: 'off' });
      locBtn  = h('button', { cls: 'mp-sb' }, 'Set');
      locGrp.append(locIn, locBtn);
      locSection.append(locLbl, locGrp);
    }

    // ── Status is log-only now; no visible status section ────────────────
    const statusEl  = h('div');
    const statusIco = h('span');
    const statusTxt = h('span');

    // ── Tote scan ─────────────────────────────────────────────────────────
    const toteSection = h('div', { cls: 'mp-section', style: 'display:none' });
    const toteLbl = h('label', { cls: 'mp-lbl' }, 'Scan Source Container / Tote');
    const toteGrp = h('div', { cls: 'mp-sg' });
    const retainedToteNo = '';
    const toteIn  = h('input', { cls: 'mp-si', type: 'text', placeholder: 'Scan tote barcode…', autocomplete: 'off', value: retainedToteNo });
    const toteBtn = h('button', { cls: 'mp-sb' }, 'Load');
    toteGrp.append(toteIn, toteBtn);

    // Retain container number checkbox
    const retainWrap = h('label', { cls: 'mp-retain-wrap' });
    const retainChk  = h('input', { type: 'checkbox' });
    // Restore persisted state
    retainChk.checked = false;
    retainChk.addEventListener('change', () => {
      localStorage.setItem(RETAIN_TOTE_ENABLED_KEY, retainChk.checked ? '1' : '0');
      if (!retainChk.checked) clearRetainedToteNumber();
      else if (toteIn.value.trim()) rememberRetainedTote(toteIn.value.trim());
    });
    const retainLbl = h('span', { cls: 'mp-retain-label' }, 'Retain container number after packing');
    retainWrap.append(retainChk, retainLbl);

    toteSection.append(toteLbl, toteGrp, retainWrap);

    // ── Shipment info card ────────────────────────────────────────────────
    const shipCard = h('div', { cls: 'mp-section', style: 'display:none' });

    // ── Container type picker ─────────────────────────────────────────────
    const boxSection = h('div', { cls: 'mp-section', style: 'display:none' });
    const boxLbl  = h('label', { cls: 'mp-lbl' }, 'Select Container Type');
    const boxList = h('div', { cls: 'mp-ctypes' });
    boxSection.append(boxLbl, boxList);

    // ── Custom container number ───────────────────────────────────────────
    const contNoSection = h('div', { cls: 'mp-section', style: 'display:none' });
    const contNoLbl = h('label', { cls: 'mp-lbl' }, 'Outbound Container Number');
    const contNoGrp = h('div', { cls: 'mp-sg' });
    const contNoIn  = h('input', { cls: 'mp-si', type: 'text', placeholder: 'Scan container barcode…', autocomplete: 'off' });
    const contNoBtn = h('button', { cls: 'mp-sb' }, 'Create');
    contNoGrp.append(contNoIn, contNoBtn);
    contNoSection.append(contNoLbl, contNoGrp);

    // ── Active container card ─────────────────────────────────────────────
    const newContCard = h('div', { cls: 'mp-section', style: 'display:none' });

    // ── Carton confirmation section ───────────────────────────────────────
    const dimsSection = h('div', { cls: 'mp-section mp-carton-confirm', style: 'display:none' });
    const dimsLbl  = null;
    const expectedCarton = h('div', { cls: 'mp-expected-carton' });
    const expectedCartonTitle = h('div', { cls: 'mp-expected-title' });
    expectedCartonTitle.innerHTML = '<strong>Expected Carton</strong>';
    const expectedCartonName = h('div', { cls: 'mp-expected-name' }, '—');
    const expectedCartonDims = h('div', { cls: 'mp-expected-dims' }, 'Dimensions —');
    expectedCarton.append(expectedCartonTitle, expectedCartonName, expectedCartonDims);
    const cartonScanIn = h('input', { cls: 'mp-si', type: 'text', placeholder: 'SCAN TO CONFIRM CONTAINER', autocomplete: 'off' });
    const lIn  = mkHiddenDimInput('length');
    const wdIn = mkHiddenDimInput('width');
    const htIn = mkHiddenDimInput('height');
    const wIn  = mkHiddenDimInput('weight');
    dimsSection.append(expectedCarton, cartonScanIn, lIn.inp, wdIn.inp, htIn.inp, wIn.inp);

    // ── Item scan ─────────────────────────────────────────────────────────
    const scanSection = h('div', { cls: 'mp-section', style: 'display:none' });
    const scanLbl = h('label', { cls: 'mp-lbl' }, 'Scan Item');
    const scanGrp = h('div', { cls: 'mp-sg' });
    const scanIn  = h('input', { cls: 'mp-si', type: 'text', placeholder: 'Scan item barcode or SKU…', autocomplete: 'off' });
    const scanBtn = h('button', { cls: 'mp-sb' }, 'OK');
    scanGrp.append(scanIn, scanBtn);

    // Qty row — sits above scan input, labelled clearly
    const qtyRow  = h('div', { cls: 'mp-qty-row' });
    const qtyLbl  = h('label', { cls: 'mp-qty-lbl' }, 'Qty');
    const qtyIn   = h('input', { cls: 'mp-qty-in', id: 'mp-qty-in', type: 'number', value: '1', min: '1', max: '999', autocomplete: 'off' });
    qtyRow.append(qtyLbl, qtyIn);

    scanSection.append(scanLbl, qtyRow, scanGrp);

    // ── Progress bar ──────────────────────────────────────────────────────
    const progWrap = h('div', { cls: 'mp-prog', style: 'display:none; margin: 0 16px 12px' });
    const progBar  = h('div', { cls: 'mp-progb', style: 'width:0%' });
    progWrap.append(progBar);

    // ── Rollback banner ───────────────────────────────────────────────────
    const rollbackBanner = h('div', { cls: 'mp-rollback-banner', style: 'display:none; margin: 0 16px 8px' });

    // ── Action buttons ────────────────────────────────────────────────────
    const actSection = h('div', { cls: 'mp-section', style: 'display:none; flex-direction:column; gap:8px' });
    const btnClose   = h('button', { cls: 'mp-btn btn-green', style: 'width:100%; font-size:18px; padding:12px' }, '✓  Close Container');
    const btnNewCont = null;
    const btnReset   = null;
    const btnShort = null;
    const btnPrint = null;
    actSection.style.display = 'none';
    actSection.style.flexDirection = 'column';
    actSection.append(btnClose);

    left.append(
      locSection, profSection,
      toteSection, shipCard, boxSection, contNoSection,
      newContCard, dimsSection, scanSection,
      progWrap, rollbackBanner, actSection,
    );

    // ════════════ RIGHT PANEL ════════════════════════════════════════════

    const right = h('div', { cls: 'mp-right' });

    // Items header
    const rh = h('div', { cls: 'mp-rh' });
    const rhTitleWrap = h('div', { cls: 'mp-rh-title' });
    rhTitleWrap.append('Items to Pack');
    const rhCnt = h('span', { cls: 'mp-rh-cnt' }, '—');
    rhTitleWrap.append(rhCnt);
    const rhFil = h('input', { cls: 'mp-filter', type: 'text', placeholder: 'Filter items…' });
    rhFil.style.display = 'none';
    rh.append(rhTitleWrap, h('div', { cls: 'sp' }));

    const list = h('div', { cls: 'mp-list' });
    const emptyEl = h('div', { cls: 'mp-empty' });
    emptyEl.innerHTML = `<div class="ico">📦</div>
      <div class="t">No Container Loaded</div>
      <div class="s">Select a packing profile and scan a tote to begin</div>`;
    list.append(emptyEl);
    right.append(rh, list);

    // ── Footer status bar ─────────────────────────────────────────────────
    const foot = h('div', { cls: 'mp-foot' });
    foot.innerHTML = `
      <span class="mp-fi">Profile <strong id="mp-f-prof">—</strong></span>
      <span class="mp-fi-sep">|</span>
      <span class="mp-fi">Container <strong id="mp-f-cont">—</strong></span>
      <span class="mp-fi-sep">|</span>
      <span class="mp-fi">Shipment <strong id="mp-f-ship">—</strong></span>
      <span class="mp-fi" style="margin-left:auto; color:var(--c7-muted2)">Malpa Pack v7</span>`;

    layout.append(left, right);
    const finaliseOverlay = h('div', { cls: 'mp-finalise-overlay' });
    finaliseOverlay.innerHTML = `<div class="mp-finalise-card"><span class="mp-finalise-spinner"></span><span id="mp-finalise-text">Finalising container… printing label</span></div>`;
    view.append(layout, foot, finaliseOverlay);

    // Inject view into body — fixed positioned overlay
    document.body.appendChild(view);
    positionTabView(view);
    window.addEventListener('resize', () => positionTabView(view));

    // Activate our tab in the tab bar
    activateMalpaTab();

    // ── Store refs ────────────────────────────────────────────────────────
    R = {
      overlay: view,  // alias so closeUI() still removes it
      win: view,
      finaliseOverlay,
      queueBadge,
      reprintBtn,
      retainChk,
      profSel,
      locSection, locIn, locBtn, locGrp,
      statusEl, statusIco, statusTxt,
      toteSection, toteIn, toteBtn,
      shipCard, boxSection, boxList,
      contNoSection, contNoIn, contNoBtn,
      newContCard,
      dimsSection,
      expectedCartonName, expectedCartonDims, cartonScanIn,
      wIn: wIn.inp, lIn: lIn.inp, wdIn: wdIn.inp, htIn: htIn.inp,
      scanSection, scanIn, scanBtn, qtyIn,
      progWrap, progBar,
      rollbackBanner,
      actSection, btnClose, btnShort, btnNewCont, btnReset, btnPrint,
      list, rhCnt, rhFil,
      dcPanel, dcTotal, dcBody, dcPopover,
      unassignBtn,
      shipBadge,
    };

    // ── Wire events ───────────────────────────────────────────────────────
    if (locBtn) locBtn.addEventListener('click',  () => onSetLocation(locIn.value.trim()));
    if (locIn)  locIn.addEventListener('keydown', e => { if (e.key === 'Enter') onSetLocation(locIn.value.trim()); });
    toteBtn.addEventListener('click',  () => onLoadTote(toteIn.value.trim()));
    toteIn.addEventListener('keydown', e => { if (e.key === 'Enter') onLoadTote(toteIn.value.trim()); });
    toteIn.addEventListener('change', () => { if (retainChk.checked) rememberRetainedTote(toteIn.value.trim()); });
    // Gate unassign button on tote input having content — covers keyboard and scanner input
    const _syncUnassignBtn = () => {
      if (R.unassignBtn && !R.unassignBtn.classList.contains('mp-unassign-alert')) {
        R.unassignBtn.disabled = !toteIn.value.trim();
        R.unassignBtn.title = toteIn.value.trim()
          ? 'Click to unassign the job for this tote'
          : 'Enter a tote number above, then click to unassign its job';
      }
    };
    toteIn.addEventListener('input',  _syncUnassignBtn);
    toteIn.addEventListener('change', _syncUnassignBtn);
    scanBtn.addEventListener('click',  () => onScan(scanIn.value.trim()));
    scanIn.addEventListener('keydown', e => { if (e.key === 'Enter') onScan(scanIn.value.trim()); });
    cartonScanIn.addEventListener('keydown', e => { if (e.key === 'Enter') onCartonConfirmScan(cartonScanIn.value.trim()); });
    contNoBtn.addEventListener('click',  () => onCreateWithCustomNo(contNoIn.value.trim()));
    contNoIn.addEventListener('keydown', e => { if (e.key === 'Enter') onCreateWithCustomNo(contNoIn.value.trim()); });
    btnClose.addEventListener('click',   onCloseContainer);
    if (btnNewCont) btnNewCont.addEventListener('click', onNewContainer);
    if (btnReset) btnReset.addEventListener('click',   onFullReset);
    rhFil.addEventListener('input', () => renderItems(rhFil.value));
    document.addEventListener('keydown', onGlobalKey);

    _queuePollInterval = setInterval(updateQueueBadge, 250);
    loadProfiles(); // auto-opens dropdown after load if location is pre-resolved
  }

  function mkHiddenDimInput(dimName) {
    const inp = h('input', {
      cls: 'mp-dim-in',
      type: 'hidden',
      name: dimName,
      id: `mp-${dimName}-input`,
      formcontrolname: dimName,
      'data-mp-dim': dimName,
      'data-dimension': dimName,
      autocomplete: 'off',
    });
    return { inp };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 10.  STATUS & QUEUE BADGE
  // ─────────────────────────────────────────────────────────────────────────────

  function setStatus(msg, type = 'idle') {
    if (!R.statusEl) return;
    console.log(`[MalpaPack] ${type}: ${msg}`);
  }

  function updateQueueBadge() {
    if (!R.queueBadge) return;
    const n = Q._running + Q._queue.length;
    R.queueBadge.textContent = `QUEUE ${n}`;
    R.queueBadge.className = n > 0 ? 'mp-titlebar-queue busy' : 'mp-titlebar-queue';
    R.queueBadge.style.display = 'none';
  }

  function showRollback(track, err) {
    if (!R.rollbackBanner) return;
    track.scanned  = Math.max(0, track.scanned - 1);
    if (track.scanned < track.required) track.done = false;
    R.rollbackBanner.textContent = `⚠ Move failed for ${track.sku}: ${err.message}. Item de-scanned — rescan required.`;
    R.rollbackBanner.style.display = '';
    EventLog.err(`Move failed for ${track.sku}: ${err.message}. Rescan required.`);
    flashRow(track.child.id, 'rollback');
    beep('err');
    SourceToteCache.syncFromTrack(track);
    updateProgress();
    updateDetailCounter();
    renderItems(R.rhFil?.value || '');
    setTimeout(() => { if (R.rollbackBanner) R.rollbackBanner.style.display = 'none'; }, 6000);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 11.  PROFILE LOADING
  // ─────────────────────────────────────────────────────────────────────────────

  /** Auto-detect the user's packing station location */
  async function autoDetectLocation() {
    // 1. Check localStorage for cached location from previous session
    const cached = localStorage.getItem('mp_pack_location');
    if (cached) {
        return cached;
    }
    // 2. Try labour/shift-user — active shift may have a workstation with location
    try {
      const shifts = await apiGet(
        `labour/shift-user&status_id=1&warehouse_id=${WAREHOUSE_ID}&expand=workstation,location`
      );
      const arr = Array.isArray(shifts) ? shifts : [];
      for (const s of arr) {
        const loc = s.workstation?.location_code || s.location?.location_code
          || s.packing_location_code || s.location_code;
        if (loc) return loc;
      }
    } catch (_) {}
    // 3. Try configuration/location with location_class_id=6 (packing) for this user
    try {
      const userId = (() => {
        // Try to get user ID from localStorage/window
        for (const key of ['user_id','userId','currentUserId']) {
          const v = localStorage.getItem(key);
          if (v && /^\d+$/.test(v)) return v;
        }
        return null;
      })();
      if (userId) {
        const locs = await apiGet(
          `configuration/location&warehouse_id=${WAREHOUSE_ID}&location_class_id=6&user_id=${userId}&per-page=1`
        );
        const arr2 = Array.isArray(locs) ? locs : [locs];
        if (arr2[0]?.location_code) return arr2[0].location_code;
      }
    } catch (_) {}
    return null;
  }

  async function loadProfiles() {
    try {
      // C: Fetch profiles + container types in parallel at startup.
      const [profiles, rawTypes] = await Promise.all([
        fetchPackingProfiles(),
        fetchContainerTypes().catch(() => []),
        ExpectedCartonCache.load().catch(() => null),
      ]);
      // Apply pre-resolved location if available (resolved at boot time).
      // buildUI already pre-fills the input — here we just set the Session state.
      if (_preloadedLocationId && !Session.packLocationId) {
        Session.packLocationId   = _preloadedLocationId;
        Session.packLocationCode = _preloadedLocation;
        updateFooter();
        if (Session.profileId) revealToteScan();
      } else if (_preloadedLocation && !_preloadedLocationId && R.locIn && !Session.packLocationId) {
        // Code known but ID still resolving — fill input so user can press Set
        R.locIn.value = _preloadedLocation;
      }
      if (!Session.containerTypes) {
        Session.containerTypes = Array.isArray(rawTypes) ? rawTypes : [];
      }
      publishContainerTypesForPackPrompt(Session.containerTypes);
      if (!R.profSel) return;
      R.profSel._profiles = profiles;
      R.profSel._list.innerHTML = '';

      // Toggle dropdown open/close
      R.profSel._btn.onclick = () => {
        if (R.profSel.disabled) return;
        const isOpen = R.profSel._list.style.display !== 'none';
        R.profSel._list.style.display = isOpen ? 'none' : '';
        R.profSel._btn.classList.toggle('open', !isOpen);
      };

      // Close on outside click — guard against R.profSel being stale after UI reset
      document.addEventListener('click', (e) => {
        if (!R.profSel?._btn) return;
        if (!R.profSel._btn.contains(e.target) && !R.profSel._list.contains(e.target)) {
          R.profSel._list.style.display = 'none';
          R.profSel._btn.classList.remove('open');
        }
      });

      for (const p of profiles) {
        const opt = h('div', { cls: 'mp-dd-opt' }, p.name);
        opt.addEventListener('click', () => {
          // Deselect previous
          R.profSel._list.querySelectorAll('.mp-dd-opt').forEach(o => o.classList.remove('active'));
          opt.classList.add('active');
          R.profSel._value = String(p.id);
          R.profSel._btnTxt.textContent = p.name;
          R.profSel._list.style.display = 'none';
          R.profSel._btn.classList.remove('open');
          onProfileChange();
        });
        R.profSel._list.append(opt);
      }
      R.profSel._btnTxt.textContent = '— Select profile —';

      // If location is already pre-resolved, open the dropdown now that options are ready.
      // Operator just needs to click their profile — nothing else required.
      if (_preloadedLocationId && !Session.profileId) {
        R.profSel._list.style.display = '';
        R.profSel._btn.classList.add('open');
      }
    } catch (err) {
      setStatus(`Failed to load profiles: ${err.message}`, 'err');
    }
  }

  function onProfileChange() {
    const sel = R.profSel;
    if (!sel.value) return;
    const profiles = sel._profiles || [];
    Session.profile   = profiles.find(p => String(p.id) === sel.value) || null;
    Session.profileId = Session.profile?.id || null;

    // If a packing session is active, reset it cleanly when the operator
    // switches profiles — otherwise the mid-session guard permanently blocks
    // the new tote scan with no way to recover except a page refresh.
    const activePhases = ['CHOOSE_BOX', 'PACKING', 'CLOSING', 'COMPLETE'];
    if (activePhases.includes(Session.phase) || Session.outboundContainer) {
      // If the container has no scanned items, delete it silently — it's an
      // empty orphan in C7. If items were already scanned, leave it open so
      // the operator or supervisor can close/unassign it manually in C7.
      const hasScannedItems = ShipmentCache.allItems.some(t => t.scanned > 0);
      if (Session.outboundContainer && !hasScannedItems) {
        deleteAbandonedContainer(Session.outboundContainer.id);
        EventLog.ok(`Empty container ${Session.outboundContainer.container_no} deleted — profile switched.`);
      } else if (Session.outboundContainer && hasScannedItems) {
        EventLog.ok(`Container ${Session.outboundContainer.container_no} left open in C7 — items were already scanned. Close or unassign manually if needed.`);
      }
      ShipmentCache.clear();
      Session.outboundContainer = null;
      Session.phase = 'SCAN_TOTE';
      updatePickerBadge(null);
      renderItems('');
      if (R.scanSection) R.scanSection.style.display = 'none';
      if (R.actSection)  R.actSection.style.display  = 'none';
      if (R.shipCard)    R.shipCard.style.display     = 'none';
      if (R.dimsSection) R.dimsSection.style.display  = 'none';
      if (R.progWrap)    R.progWrap.style.display     = 'none';
    }

    updateFooter();
    if (Workflow.usesRetainedSourceFlow() && R.retainChk) {
      R.retainChk.checked = true;
      localStorage.setItem(RETAIN_TOTE_ENABLED_KEY, '1');
    }
    // If location already set, reveal tote scan
    if (Session.packLocationId) revealToteScan();
    setStatus(`Profile "${Session.profile?.name}" selected.`, 'ok');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 12.  LOCATION
  // ─────────────────────────────────────────────────────────────────────────────

  function renderLocationCompact(locationCode) {
    const code = String(locationCode || Session.packLocationCode || '').trim();
    if (!R.locSection || !code) return;
    R.locSection.style.cssText = 'padding:8px 16px;border-bottom:1px solid var(--c7-border);background:rgba(16,185,129,0.06);flex-shrink:0';
    R.locSection.innerHTML = '';
    const locConfirm = h('div', {}, '');
    locConfirm.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:16px;color:var(--c7-muted)';
    locConfirm.innerHTML = `<span style="color:var(--c7-green);font-size:18px">✓</span> Pack location <strong style="color:var(--c7-text);font-family:var(--c7-mono)">${code}</strong> <span style="margin-left:auto;font-size:14px;color:var(--c7-muted2);cursor:pointer" id="mp-loc-edit">change</span>`;
    R.locSection.appendChild(locConfirm);
    R.locIn = null;
    R.locBtn = null;
    R.locGrp = null;
    const editLink = locConfirm.querySelector('#mp-loc-edit');
    if (editLink) editLink.addEventListener('click', renderLocationEditable);
  }

  function renderLocationEditable() {
    if (!R.locSection) return;
    R.locSection.style.cssText = 'padding:14px 16px;border-bottom:1px solid var(--c7-border);flex-shrink:0';
    R.locSection.innerHTML = '';
    const lbl = h('label', { cls: 'mp-lbl' }, 'Pack-To Location');
    const grp = h('div', { cls: 'mp-sg' });
    const inp = h('input', { cls: 'mp-si', type: 'text', value: Session.packLocationCode || _preloadedLocation || '', placeholder: 'e.g. WDD-01', autocomplete: 'off' });
    const btn = h('button', { cls: 'mp-sb' }, 'Set');
    btn.addEventListener('click', () => onSetLocation(inp.value.trim()));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') onSetLocation(inp.value.trim()); });
    grp.append(inp, btn);
    R.locSection.append(lbl, grp);
    R.locIn = inp;
    R.locBtn = btn;
    R.locGrp = grp;
    inp.focus();
    inp.select?.();
  }

  async function onSetLocation(code) {
    // Strip any non-alphanumeric characters except hyphen/underscore from location code
    code = code.replace(/[^a-zA-Z0-9\-_]/g, '').toUpperCase();
    if (!code) { setStatus('Enter a location code.', 'err'); return; }
    setStatus(`Resolving ${code}…`, 'loading');
    R.locBtn.disabled = true;
    try {
      const loc = await fetchLocationByCode(code);
      Session.packLocationId   = loc.id;
      Session.packLocationCode = loc.location_code;
      if (R.locIn) R.locIn.value = loc.location_code;
      renderLocationCompact(loc.location_code);
      // Cache for next session
      try { localStorage.setItem('mp_pack_location', loc.location_code); } catch(_) {}
      updateFooter();
      setStatus(`Location "${loc.location_code}" (ID ${loc.id}) set.`, 'ok');
      if (Session.profileId) revealToteScan();
    } catch (err) {
      setStatus(`Location error: ${err.message}`, 'err');
    }
    if (R.locBtn) R.locBtn.disabled = false;
  }

  function revealToteScan() {
    if (!R.toteSection) return;
    R.toteSection.style.display = '';
    setTimeout(() => R.toteIn && R.toteIn.focus(), 80);
    if (Session.phase === 'BOOT') Session.phase = 'SCAN_TOTE';
    // Only enable unassign if the tote field already has a value — prevents
    // clicking it on an empty field.
    if (R.unassignBtn) {
      const hasTote = !!(R.toteIn?.value?.trim());
      R.unassignBtn.disabled = !hasTote;
      R.unassignBtn.title = hasTote
        ? 'Click to unassign the job for this tote'
        : 'Enter a tote number above, then click to unassign its job';
    }
  }

  function showSibpItemScan(sourceContainerNo) {
    Session.sibpSourceContainerNo = String(sourceContainerNo || '').trim();
    Session.phase = 'SIBP_ITEM_SCAN';
    ShipmentCache.clear();
    if (R.shipCard) R.shipCard.style.display = 'none';
    if (R.boxSection) R.boxSection.style.display = 'none';
    if (R.contNoSection) R.contNoSection.style.display = 'none';
    if (R.newContCard) R.newContCard.style.display = 'none';
    if (R.dimsSection) R.dimsSection.style.display = 'none';
    if (R.progWrap) R.progWrap.style.display = 'none';
    if (R.actSection) R.actSection.style.display = 'none';
    if (R.scanSection) {
      R.scanSection.style.display = '';
      const lbl = R.scanSection.querySelector('.mp-lbl');
      if (lbl) lbl.textContent = 'Scan Item From Cart';
    }
    if (R.scanIn) {
      R.scanIn.placeholder = 'Scan any item to load its shipment…';
      R.scanIn.disabled = !!Session.sibpProcessing;
      R.scanIn.value = '';
      if (!Session.sibpProcessing) setTimeout(() => R.scanIn && R.scanIn.focus(), 80);
    }
    renderItems('');
    updateDetailCounter();
    updateFooter();
    setStatus(Session.sibpProcessing
      ? `Processing ${Session.sibpSourceContainerNo} — wait for label/container finish…`
      : `SIBP source ${Session.sibpSourceContainerNo} loaded — scan any item.`,
      Session.sibpProcessing ? 'loading' : 'ok'
    );
  }

  function setSibpItemScanEnabled(enabled) {
    if (!R.scanIn) return;
    R.scanIn.disabled = !enabled;
    R.scanIn.placeholder = enabled
      ? 'Scan any item to load its shipment…'
      : 'Waiting for previous container to finish…';
    if (enabled) {
      R.scanIn.value = '';
      setTimeout(() => R.scanIn && R.scanIn.focus(), 80);
    }
  }

  async function onSibpItemScan(raw) {
    const t0 = perfNow();
    if (Session.sibpProcessing) {
      if (R.scanIn) R.scanIn.value = '';
      setStatus('Still processing previous SIBP container — wait for it to finish.', 'loading');
      beep('err');
      return;
    }
    const itemCode = String(raw || '').trim();
    if (!itemCode || !Session.sibpSourceContainerNo) return;
    if (R.scanIn) R.scanIn.value = '';
    setStatus(`Finding shipment for ${itemCode}…`, 'loading');
    renderLoadingItems(itemCode); // v3.3.82 — instant visual feedback
    try {
      const data = await fetchPackContainer(Session.sibpSourceContainerNo, Session.profileId, itemCode);
      const containers = Array.isArray(data) ? data : [data];
      if (!containers.length) throw new Error('No packing data found for that item.');

      ShipmentCache.clear();
      ShipmentCache.loadFromGPC(containers);
      ShipmentCache.sourceContainerNo = Session.sibpSourceContainerNo;
      _shipmentGen++; // v3.3.80 — a new shipment is now active

      // Update ship badge with the real shipment number now that GPC has resolved
      updateShipBadge(ShipmentCache.shipmentHeader?.shipment_number || Session.sibpSourceContainerNo);

      renderShipCard();
      renderItems('');
      updateDetailCounter();
      beep('ok');
      Session.phase = 'CHOOSE_BOX';
      await initiateContainerCreation();
      perfMark('SIBP item scan to packing ready', t0, itemCode);

      // Process the initiating scan against the now-loaded shipment.
      onScan(itemCode);
    } catch (err) {
      setStatus(`SIBP item load error: ${err.message}`, 'err');
      EventLog.err(`SIBP item scan failed: ${err.message}`);
      beep('err');
      shakeStatus();
      Session.phase = 'SIBP_ITEM_SCAN';
      renderItems(''); // v3.3.82 — clear loading skeletons on failure
      if (R.scanIn) R.scanIn.focus();
    }
  }

  async function maybeAutoLoadRetainedTote(reason = 'retained') {
    if (_autoLoadInFlight) return false;
    if (!R.retainChk?.checked) return false;
    if (!Session.profileId || !Session.packLocationId) return false;

    const retainedNo = (localStorage.getItem(RETAIN_TOTE_NO_KEY) || R.toteIn?.value || '').trim();
    if (!retainedNo) return false;

    _autoLoadInFlight = true;
    try {
      if (R.toteIn) R.toteIn.value = retainedNo;
      setStatus(reason === 'after-close'
        ? `Loading next shipment from retained tote ${retainedNo}…`
        : `Auto-loading retained tote ${retainedNo}…`, 'loading');
      await onLoadTote(retainedNo, { auto: true });
      return true;
    } finally {
      _autoLoadInFlight = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 12b.  MULTI-TOTE AWARENESS MODAL
  //       Fires after GPC when the shipment spans more than one source container.
  //       Returns a Promise that resolves only when the operator dismisses it —
  //       initiateContainerCreation() is awaited after this resolves.
  // ─────────────────────────────────────────────────────────────────────────────

  function showMultiToteModal(toteNumbers, currentToteNo) {
    return new Promise(resolve => {
      const overlay = h('div', { cls: 'mp-multitote-overlay' });
      const modal   = h('div', { cls: 'mp-multitote-modal' });

      const icon  = h('div', { cls: 'mp-multitote-icon' }, '🗂️');
      const title = h('div', { cls: 'mp-multitote-title' },
        `Multi-Tote Shipment — ${toteNumbers.length} Totes`);
      const sub   = h('div', { cls: 'mp-multitote-sub' },
        'This shipment spans multiple source totes. Pack each tote in sequence.');

      const list = h('div', { cls: 'mp-multitote-list' });
      toteNumbers.forEach((no, i) => {
        const isCurrent = String(no).trim() === String(currentToteNo).trim();
        const row = h('div', { cls: 'mp-multitote-list-item' });
        row.append(
          h('span', { cls: 'mt-idx' }, `#${i + 1}`),
          h('span', { cls: 'mt-no'  }, String(no)),
        );
        if (isCurrent) row.append(h('span', { cls: 'mt-cur' }, '← CURRENT'));
        list.append(row);
      });

      const confirmBtn = h('button', { cls: 'mp-multitote-confirm' }, 'I Understand');

      const dismiss = () => {
        overlay.remove();
        modal.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve();
        // Return focus to the scan input so the operator can scan immediately
        // without having to manually click the field.
        setTimeout(() => {
          const target = R.scanIn || R.toteIn;
          if (target && !target.disabled) target.focus();
        }, 50);
      };

      confirmBtn.addEventListener('click', dismiss);

      // Also allow Enter key to dismiss while modal is open
      const onKey = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          dismiss();
        }
      };
      document.addEventListener('keydown', onKey, true);

      modal.append(icon, title, sub, list, confirmBtn);
      // Append overlay and modal separately to document.body — same pattern as
      // showContainerEmptyPopup — so the modal's fixed 50%/50% centres correctly.
      document.body.append(overlay, modal);

      // Focus the button so Enter works immediately without mouse interaction
      setTimeout(() => confirmBtn.focus(), 80);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 13.  LOAD TOTE (get-pack-container — called ONCE)
  // ─────────────────────────────────────────────────────────────────────────────

  async function onLoadTote(containerNo, opts = {}) {
    const t0 = perfNow();
    if (!containerNo) { setStatus('Enter a container number.', 'err'); return; }
    if (!Session.profileId)      { setStatus('Select a packing profile first.', 'err'); return; }
    if (!Session.packLocationId) { setStatus('Set a pack-to location first.', 'err'); return; }

    // ── Mid-session guard ─────────────────────────────────────────────────────
    // If a container is already open in C7, block loading a new tote entirely.
    // Scanning a second tote mid-pack creates a ghost container in C7 because
    // the first outbound container is left open with no items moved to it.
    const activePhases = ['CHOOSE_BOX', 'PACKING', 'CLOSING'];
    if (activePhases.includes(Session.phase) || Session.outboundContainer) {
      setStatus('⚠ Close the current container before scanning a new tote.', 'err');
      beep('err');
      shakeStatus();
      if (R.toteIn) R.toteIn.value = '';
      return;
    }

    // ── Clear stale shipment data before loading new tote ─────────────────────
    // Ensures items from an abandoned session never bleed into the new shipment.
    ShipmentCache.clear();
    Session._currentPieceScannedQty = 0;
    EventLog.clear(); // clear log only when a new tote is scanned, not on consign
    renderItems('');

    // v3.3.80: prefetch the first container number in parallel with GPC.
    // Later containers are already prefetched by _revealPackingUI; this covers
    // the first container after script load (saves ~0.7s, HAR-measured).
    if (Workflow.autoGenerateContainer() && !Session._nextContainerNo) {
      autoGenerateContainerNumber()
        .then(no => { Session._nextContainerNo = no; })
        .catch(() => {});
    }

    if (Workflow.usesItemInitiatedFlow()) {
      Session.sibpSourceContainerNo = String(containerNo || '').trim();
      Session.sibpProcessing = false;
      if (R.retainChk?.checked) rememberRetainedTote(Session.sibpSourceContainerNo);
      // For SIBP the source-tote detail counter is informational only. Do not
      // block item scanning while the Retool inventory workflow runs.
      SourceToteCache.ensure(Session.sibpSourceContainerNo);
      showSibpItemScan(Session.sibpSourceContainerNo);
      perfMark('SIBP source tote ready for item scan', t0, Session.sibpSourceContainerNo);
      loadToteInventoryDetailsInBackground(Session.sibpSourceContainerNo, { label: 'SIBP source tote detail' });
      // ── Picker badge ─────────────────────────────────────────────────────
      updatePickerBadge(null);
      fetchLastPickerForTote(Session.sibpSourceContainerNo)
        .then(username => updatePickerBadge(username))
        .catch(() => {});
      // ── Ship badge — show tote number immediately, shipment number will
      // update once GPC resolves on first item scan
      updateShipBadge(Session.sibpSourceContainerNo);
      return true;
    }

    setStatus(`Loading ${containerNo}…`, 'loading');
    renderLoadingItems(containerNo); // v3.3.82 — instant visual feedback
    R.toteBtn.disabled = true;
    // Lock profile + location so re-firing during active session is prevented
    if (R.profSel) R.profSel.disabled = true;
    if (R.locBtn)  R.locBtn.disabled  = true;
    if (R.locIn)   R.locIn.disabled   = true;
    try {
      // A: Fire GPC, container types, and open-container check in parallel.
      // The open-container check detects any containers created before a page
      // refresh — we reuse them instead of creating empty duplicates.
      // If types already cached from startup (opt C), the second promise resolves instantly.
      const [data, rawTypes, existingOpenContainers] = await Promise.all([
        fetchPackContainer(containerNo, Session.profileId),
        Session.containerTypes ? Promise.resolve(Session.containerTypes)
          : fetchContainerTypes().catch(() => []),
        Promise.resolve([]), // placeholder — filled after we have shipmentHeaderId from GPC
      ]);
      if (!Session.containerTypes) {
        Session.containerTypes = Array.isArray(rawTypes) ? rawTypes : [];
      }
      publishContainerTypesForPackPrompt(Session.containerTypes);
      const containers = Array.isArray(data) ? data : [data];
      if (!containers.length) throw new Error('No packing data found for that container.');

      ShipmentCache.loadFromGPC(containers);
      ShipmentCache.sourceContainerNo = containerNo;
      _shipmentGen++; // v3.3.80 — a new shipment is now active

      // Now we have the shipmentHeaderId — fetch open containers for this shipment
      const shipmentHeaderId = ShipmentCache.shipmentHeader?.id;

      // Self-heal abandoned sessions: empty closed (status 7) containers hold
      // stranded weights for units the operator is about to re-verify. Remove
      // them now so the shipment's declared weight cannot inflate. Runs in the
      // background — never blocks the operator.
      // v3.3.80: kicked off BEFORE awaiting the open-container check so both
      // requests run in parallel instead of back-to-back (HAR showed them
      // serialised at ~750ms each).
      if (shipmentHeaderId) {
        cleanupEmptyClosedContainers(shipmentHeaderId).catch(() => {});
      }

      // v3.3.81: start the open-container check now but DON'T await it yet —
      // the items list only needs GPC data, so it renders first (operators
      // reported 2-3s tote-scan-to-items; this puts items on screen at GPC
      // time). The result is awaited below, before container create/reuse.
      // fetchOpenOutboundContainersForShipment never rejects (returns [] on
      // error), so holding the un-awaited promise is safe.
      const openContainersPromise = shipmentHeaderId
        ? fetchOpenOutboundContainersForShipment(shipmentHeaderId)
        : Promise.resolve([]);
      SourceToteCache.ingestFromGPC(containerNo, containers);
      if (Workflow.usesRetainedSourceFlow()) {
        loadToteInventoryDetailsInBackground(containerNo, {
          label: 'MIBP source tote detail',
          fallbackContainers: containers,
        });
      }
      if (Workflow.usesRetainedSourceFlow() && R.retainChk) {
        R.retainChk.checked = true;
        localStorage.setItem(RETAIN_TOTE_ENABLED_KEY, '1');
      }
      if (R.retainChk?.checked) rememberRetainedTote(containerNo);

      // Store job_id from jobInstruction — enables unassign button
      const ji = ShipmentCache.jobInstruction;
      _currentJobId = ji?.job_id || ji?.id || null;
      if (R.unassignBtn) {
        R.unassignBtn.disabled = !_currentJobId;
        R.unassignBtn.title = _currentJobId
          ? `Unassign job ${_currentJobId} from this container`
          : 'No job linked to this container';
      }

      renderShipCard();
      // Items rendered here; also re-rendered in _revealPackingUI for safety
      renderItems('');
      beep('ok');
      Session.phase = 'CHOOSE_BOX';
      setStatus(`Loaded — ${ShipmentCache.allItems.length} item line(s).`, 'ok');
      EventLog.ok(`Tote ${containerNo} loaded — ${ShipmentCache.allItems.length} item line(s).`);

      // Update shipment badge with the loaded shipment number
      updateShipBadge(ShipmentCache.shipmentHeader?.shipment_number || containerNo);

      // ── Picker badge: fire background lookup, never blocks operator ───────
      updatePickerBadge(null); // clear any previous tote's badge immediately
      fetchLastPickerForTote(containerNo)
        .then(username => updatePickerBadge(username))
        .catch(() => {}); // silent fail — informational only

      // Multi-tote awareness: if the shipment spans more than one distinct source
      // container, surface a modal before proceeding so the operator knows to
      // expect multiple totes and can see all tote numbers at once.
      const allToteNos = [...new Set(
        containers
          .map(c => c.container_no || c.container_number)
          .filter(Boolean)
      )];
      if (allToteNos.length > 1) {
        await showMultiToteModal(allToteNos, containerNo);
      }

      const openContainers = await openContainersPromise; // v3.3.81
      await initiateContainerCreation(openContainers);
      perfMark('tote load to packing ready', t0, containerNo);
      return true;
    } catch (err) {
      setStatus(`Load error: ${err.message}`, 'err');
      EventLog.err(`Load error: ${err.message}`);
      renderItems(''); // v3.3.82 — clear loading skeletons on failure
      beep('err');
      // Re-enable controls so operator can retry
      if (R.profSel) R.profSel.disabled = false;
      if (R.locBtn)  R.locBtn.disabled  = false;
      if (R.locIn)   R.locIn.disabled   = false;

      // If the error looks like a job-assignment block, look up the job_id
      // so the operator can unassign and retry without leaving the screen.
      // We do this silently — if it fails we just don't enable the button.
      if (containerNo) {
        fetchJobIdByContainer(containerNo).then(jobId => {
          _currentJobId = jobId;
          if (R.unassignBtn) {
            R.unassignBtn.disabled = false;
            R.unassignBtn.title = `Unassign job ${jobId}, then retry loading the tote`;
            R.unassignBtn.classList.add('mp-unassign-alert');
          }
          setStatus(`Load failed — ${err.message}. Found related job ${jobId}, but this does not prove it is assigned to another user. Do not unassign unless C7 shows it is locked.`, 'warn');
        }).catch(() => {
          // Couldn't find job — leave button disabled, error message already shown
        });
      }
    }
    R.toteBtn.disabled = false;
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 14.  CHOOSE BOX TYPE
  // ─────────────────────────────────────────────────────────────────────────────

  /*
   * ── CONTAINER CREATION — THREE PATHS BASED ON PROFILE FLAGS ────────────────
   *
   *  PATH A — auto_generate=1, default_container_type_id set
   *    → Silently auto-generate number + use default type → create immediately.
   *    → No user prompt at all.
   *    → Examples: profiles 7, 11, 15, 16, 18, 19.
   *
   *  PATH B — auto_generate=0, confirm_container_type=1
   *    → Show type-picker cards. After selection: auto-generate number → create.
   *    → Examples: profiles 12 (LOCOD), 17 (Cluster Packing).
   *
   *  PATH C — auto_generate=0, confirm_container_type=0, no default type
   *    → Show container number scan input only. No type picker shown.
   *    → container_type_id is resolved from the scanned barcode prefix,
   *      matching against the prefixes in get-shipment-container-type.
   *    → This is exactly what the native Canary7 app does.
   *    → Examples: profiles 9 (Full Manual), 10 (Bulky), 14 (Wholesale).
   *
   *  Container types are fetched once and cached in Session.containerTypes
   *  for prefix-matching in Path C.
   */

  async function initiateContainerCreation(openContainers = []) {
    const auto    = Workflow.autoGenerateContainer();
    const confirm = Workflow.confirmContainerType();
    const defId   = Workflow.defaultContainerTypeId();

    // Pre-fetch container types for all paths (needed for prefix matching in Path C)
    if (!Session.containerTypes) {
      try {
        const types = await fetchContainerTypes();
        Session.containerTypes = Array.isArray(types) ? types : [types];
        publishContainerTypesForPackPrompt(Session.containerTypes);
      } catch (_) {
        Session.containerTypes = [];
      }
    }

    // ── Refresh recovery: reuse an existing open container ─────────────────────
    // If an open outbound container already exists for this shipment, the operator
    // likely refreshed mid-session. Reuse it instead of creating a new empty one.
    // Safety checks: must be for this shipment (shipment_header_id match) and
    // must be open (status_id 5) and must be an outbound container (to_container 1).
    const sh = ShipmentCache.shipmentHeader;
    const existingOpen = openContainers.find(c =>
      c.shipment_header_id === sh?.id &&
      c.status_id === 5 &&
      c.to_container === 1
    );

    if (existingOpen) {
      // An open outbound container exists for this shipment — always reuse it.
      // Previously empty containers were deleted and recreated, but this caused
      // consignment issues when operators refreshed mid-session before scanning
      // any items: the delete API call could fail silently, leaving an orphaned
      // empty container that then caused a duplicate container on consign.
      // An empty open container is perfectly valid to pack into — just resume it.
      const ct = (Session.containerTypes || []).find(t => t.id === existingOpen.container_type_id)
        || existingOpen.containerType
        || { id: existingOpen.container_type_id };
      Session.outboundContainer = existingOpen;
      Session.containerType = ct;
      _prefillDims(ct);
      const packedChildren = (existingOpen.shipmentDetailChildren || [])
        .filter(c => (c.quantity_packed || c.quantity || 0) > 0);
      if (packedChildren.length > 0) {
        EventLog.ok(`Resumed container ${existingOpen.container_no} — refreshed session detected.`);
        setStatus(`Resumed — container ${existingOpen.container_no} ready. Scan items.`, 'ok');
      } else {
        EventLog.ok(`Resuming container ${existingOpen.container_no} — ready to scan.`);
        setStatus(`Container ${existingOpen.container_no} ready. Scan items.`, 'ok');
      }
      _revealPackingUI(existingOpen, ct);
      return;
    }

    if (auto && defId) {
      await _autoCreateContainer(defId);
    } else if (!auto && confirm) {
      await _showTypePicker();
    } else {
      _showContainerScanInput();
    }
  }

  // ── PATH A ──────────────────────────────────────────────────────────────────
  async function _autoCreateContainer(containerTypeId) {
    setStatus('Creating outbound container…', 'loading');
    try {
      // B+OPT2: Use pre-fetched container number if available, else fetch in parallel with type.
      const cached = (Session.containerTypes || []).find(t => t.id === containerTypeId);
      const preNo  = Session._nextContainerNo;
      Session._nextContainerNo = null; // consume it
      const needsDims = Workflow.requiresDimsConfirm() || Workflow.requiresWeightConfirm();
      const [containerNo, ct] = await Promise.all([
        preNo ? Promise.resolve(preNo) : autoGenerateContainerNumber(),
        // Only fetch full container type if we need dims for display.
        // If dims are hidden (most auto-generate profiles), use cached type or minimal stub.
        (needsDims && !cached)
          ? fetchContainerTypeById(containerTypeId)
          : Promise.resolve(cached || { id: containerTypeId }),
      ]);
      Session.containerType = ct;
      const created = await createShipmentContainer(containerNo, containerTypeId);
      Session.outboundContainer = created;
      _prefillDims(ct);
      _revealPackingUI(created, ct);
    } catch (err) {
      setStatus(`Container create error: ${err.message}`, 'err');
      EventLog.err(`Container create failed: ${err.message}`);
      beep('err');
    }
  }

  // ── PATH B ──────────────────────────────────────────────────────────────────
  let _selBoxEl = null;

  async function _showTypePicker() {
    R.boxList.innerHTML = '';
    const arr = Session.containerTypes || [];
    for (const ct of arr) {
      const btn = h('div', { cls: 'mp-ctype', onclick: () => _onTypeSelected(ct, btn) });
      const icon = ct.name.toLowerCase().includes('satchel') ? '📮'
        : ct.name.toLowerCase().includes('box') ? '📦' : '🗃️';
      const info = h('div', {});
      info.append(
        h('div', { cls: 'mp-ctype-name' }, ct.name),
        h('div', { cls: 'mp-ctype-dims' },
          `${ct.container_length}×${ct.container_width}×${ct.container_height} cm  |  max ${ct.container_max_weight} kg`),
      );
      btn.append(h('span', { cls: 'mp-ctype-icon' }, icon), info);
      R.boxList.append(btn);
    }
    R.boxSection.style.display = '';
    setStatus('Select the outbound container type.', 'idle');
  }

  async function _onTypeSelected(ct, el) {
    if (_selBoxEl) _selBoxEl.classList.remove('sel');
    el.classList.add('sel');
    _selBoxEl = el;
    Session.containerType = ct;
    _prefillDims(ct);
    R.boxSection.style.display = 'none';
    setStatus('Creating outbound container…', 'loading');
    try {
      const containerNo = await autoGenerateContainerNumber();
      const created = await createShipmentContainer(containerNo, ct.id);
      Session.outboundContainer = created;
      _revealPackingUI(created, ct);
    } catch (err) {
      setStatus(`Container create error: ${err.message}`, 'err');
      EventLog.err(`Container create failed: ${err.message}`);
      beep('err');
    }
  }

  // ── PATH C ──────────────────────────────────────────────────────────────────
  function _showContainerScanInput() {
    if (R.contNoSection) {
      R.contNoIn.placeholder = 'Scan outbound container barcode…';
      R.contNoIn.value = '';
      R.contNoSection.style.display = '';
      setTimeout(() => R.contNoIn && R.contNoIn.focus(), 80);
    }
    setStatus('Scan the outbound container barcode.', 'idle');
  }

  /**
   * Resolve container_type_id from a scanned container number by matching
   * its prefix against known container type prefixes.
   * e.g. "RSC-001" → type 27 (Small Box), "#12345" → type 41 (WHOLESALE)
   * Sorts by prefix length descending so longer prefixes match first.
   */
  function _resolveTypeFromBarcode(no) {
    const types = Session.containerTypes || [];
    const sorted = [...types]
      .filter(t => t.container_number_prefix)
      .sort((a, b) => b.container_number_prefix.length - a.container_number_prefix.length);
    const upper = no.toUpperCase();
    for (const t of sorted) {
      if (upper.startsWith(t.container_number_prefix.toUpperCase())) {
        return t;
      }
    }
    return null;
  }

  async function onCreateWithCustomNo(no) {
    if (!no) { setStatus('Scan the outbound container barcode.', 'err'); return; }
    R.contNoBtn.disabled = true;
    setStatus('Creating outbound container…', 'loading');
    try {
      // Resolve type from barcode prefix — matches native Canary7 behaviour
      const ct = _resolveTypeFromBarcode(no);
      if (!ct) {
        // No prefix match — inform operator and ask them to check the barcode
        setStatus(`Cannot determine container type from barcode "${no}". Check the label prefix.`, 'err');
        EventLog.err(`Unknown container barcode "${no}" — prefix not recognised.`);
        beep('err');
        R.contNoBtn.disabled = false;
        return;
      }
      Session.containerType = ct;
      _prefillDims(ct);
      const created = await createShipmentContainer(no, ct.id);
      Session.outboundContainer = created;
      _revealPackingUI(created, ct);
    } catch (err) {
      setStatus(`Container create error: ${err.message}`, 'err');
      EventLog.err(`Container create failed: ${err.message}`);
      beep('err');
    }
    R.contNoBtn.disabled = false;
  }

  // ── SHARED HELPERS ───────────────────────────────────────────────────────────

  function _prefillDims(ct) {
    // Keep carton fields visually empty for the operator/scanner workflow.
    // The hidden weight field is also left empty: carton/satchel profiles should
    // use calculate_container_weight so close uses packed item weight instead.
    Session.confirmedCartonType = null;
    if (R.wIn)  R.wIn.value  = '';
    if (R.lIn)  R.lIn.value  = '';
    if (R.wdIn) R.wdIn.value = '';
    if (R.htIn) R.htIn.value = '';
    updateCartonConfirmUI(ct);
  }

  function _revealPackingUI(created, ct) {
    R.boxSection.style.display    = 'none';
    R.contNoSection.style.display = 'none';
    // Dimension/weight prompts stay hidden until every item is verified.
    // Carton workflows should feel normal while scanning items, then prompt for
    // L/W/H at the end before close-to-container fires.
    R.dimsSection.style.display   = 'none';
    R.scanSection.style.display   = '';
    R.progWrap.style.display      = 'block';
    R.actSection.style.display    = 'flex';
    R.actSection.style.flexDirection = 'column';
    renderNewContCard(created, ct);
    renderItems('');           // always re-render items when entering PACKING phase
    _containerEmptyShown = false; // reset so popup can fire for this container
    updateProgress();
    updateDetailCounter();
    updateFooter();
    Session.phase = 'PACKING';
    setStatus(`Container ${created.container_no} ready — scan items now.`, 'ok');
    EventLog.ok(`Outbound container ${created.container_no} created — ready to scan.`);
    beep('ok');
    // Close button: disabled until at least one item is scanned and confirmed.
    // For early-close profiles (Cluster), unlocks after first item move confirms.
    // For all-items-required profiles, unlocks only when all items are done.
    if (R.btnClose) {
      R.btnClose.disabled = true;
      R.btnClose.style.opacity = '.55';
      R.btnClose.title = Workflow.allowEarlyClose()
        ? 'Scan at least one item before closing this container'
        : 'Scan and confirm all items before closing this container';
    }
    setTimeout(() => R.scanIn && R.scanIn.focus(), 120);

    // OPT2: Pre-fetch next container number in background while operator scans.
    // Only for auto-generate profiles — stored in Session._nextContainerNo.
    // Eliminates ~330ms wait when operator hits New Container.
    if (Workflow.autoGenerateContainer()) {
      Session._nextContainerNo = null;
      autoGenerateContainerNumber()
        .then(no => { Session._nextContainerNo = no; })
        .catch(() => {}); // silent — will fall back to fresh fetch if this fails
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 15.  SCAN (OPTIMISTIC)
  //      1. Match barcode client-side → instant feedback
  //      2. Enqueue verification (fire-and-forget, best effort)
  //      3. Enqueue move-into-container → rollback on failure
  // ─────────────────────────────────────────────────────────────────────────────

  function lockScanForFinalising(text = 'Finalising container… printing label') {
    if (R.scanIn) {
      R.scanIn.value = '';
      R.scanIn.disabled = true;
    }
    if (R.scanBtn) R.scanBtn.disabled = true;
    if (R.qtyIn)  R.qtyIn.disabled = true;
    setFinalising(true, text);
    setStatus(text, 'loading');
  }

  function unlockScanAfterFinalising() {
    if (R.scanBtn) R.scanBtn.disabled = false;
    if (R.scanIn)  R.scanIn.disabled  = false;
    if (R.qtyIn)   { R.qtyIn.disabled = false; R.qtyIn.value = '1'; }
  }

  function updateCloseButtonReady() {
    if (!R.btnClose || Session.phase !== 'PACKING') return;
    const allDone  = ShipmentCache.allDone;
    const earlyOk  = Workflow.allowEarlyClose() && ShipmentCache.allItems.some(t => t.scanned > 0);

    R.btnClose.disabled = (!allDone && !earlyOk);
    R.btnClose.style.opacity = R.btnClose.disabled ? '.55' : '';
    R.btnClose.title = (!allDone && !earlyOk)
      ? 'Scan at least one item before closing this container'
      : allDone
        ? 'Close this container'
        : 'Close this container — remaining items will continue in the next piece';
  }

  function onScan(raw) {
    if (Workflow.usesItemInitiatedFlow() && Session.phase === 'SIBP_ITEM_SCAN') {
      onSibpItemScan(raw);
      return;
    }
    if (!raw || Session.phase !== 'PACKING') return;
    if (R.scanIn) R.scanIn.value = '';

    const scan = raw.trim();

    // Read optional quantity — defaults to 1 if blank or invalid
    const qtyRaw = parseInt(R.qtyIn?.value || '1', 10);
    const qty    = (Number.isFinite(qtyRaw) && qtyRaw >= 1) ? qtyRaw : 1;
    // Reset qty back to 1 after use so next scan is single-unit by default
    if (R.qtyIn) R.qtyIn.value = '1';

    // Client-side match — skip local-only placeholder children (created by split
    // fallback) and already-confirmed children to avoid double moves to C7.
    let matched = null;
    for (const track of ShipmentCache.allItems) {
      if (track.done) continue;
      if (track.child?._localOnly) continue; // fake split placeholder — not a real C7 child
      if (track.matches(scan)) { matched = track; break; }
    }

    if (!matched) {
      setStatus(`"${raw}" not found in this shipment.`, 'err');
      EventLog.err(`Scan rejected: "${raw}" not found in this shipment.`);
      beep('err');
      shakeStatus();
      if (R.scanIn) R.scanIn.focus();
      return;
    }

    // Optimistic increment by qty (capped at required)
    const prev = matched.scanned;
    matched.scanned = Math.min(matched.scanned + qty, matched.required);

    const actualAdded = matched.scanned - prev;
    const fullyScanned = matched.scanned >= matched.required;
    if (fullyScanned) matched.done = true;
    SourceToteCache.syncFromTrack(matched);

    // Track units scanned in current piece for proportional weight calculation
    Session._currentPieceScannedQty = (Session._currentPieceScannedQty || 0) + actualAdded;

    // Immediate UI feedback
    beep(fullyScanned ? 'scan_done' : 'scan_partial');
    if (fullyScanned) {
      EventLog.ok(`✓ ${matched.sku} — fully verified (${matched.required}/${matched.required})`);
    } else {
      EventLog.ok(`${matched.sku} — ${matched.scanned}/${matched.required} scanned${actualAdded > 1 ? ` (+${actualAdded})` : ''}`);
    }
    flashRow(matched.child.id, fullyScanned ? 'fG' : 'fA');
    updateProgress();
    updateDetailCounter();
    renderItems(R.rhFil?.value || '');
    scrollIntoView(matched.child.id);
    if (R.scanIn) R.scanIn.focus();

    // Async: verification (best effort)
    enqueueVerification(matched);

    // Async: move-into-container (with rollback). Enqueue before any close
    // decision so fast operators cannot close before the move exists in Q.
    if (fullyScanned) {
      enqueueMoveIntoContainer(matched, (err) => {
        showRollback(matched, err);
      });
    }

    updateCloseButtonReady();

    if (ShipmentCache.allDone) {
      beep('all_done');
      if (Session.phase === 'PACKING') {
        if (_requiresClosePrompt()) {
          if (R.scanIn) {
            R.scanIn.value = '';
            R.scanIn.disabled = true;
          }
          if (R.scanBtn) R.scanBtn.disabled = true;
          showClosePrompt('All items verified — scan carton details to close.', 'loading');
        } else {
          // Final item accepted. Lock the scan UI immediately so operators do
          // not keep scanning while C7 move/close/print work is settling.
          lockScanForFinalising('Final item verified — closing container and printing label…');
          Q.drain().then(() => {
            updateCloseButtonReady();
            if (Session.phase === 'PACKING') onCloseContainer();
          });
        }
      }
    }
  }

  function _requiresClosePrompt() {
    return Workflow.requiresDimsConfirm() || Workflow.requiresWeightConfirm();
  }

  function extractCartonCode(value) {
    const m = String(value || '').match(/E[-\s]?(\d+(?:\.\d+)?)/i);
    return m ? `E-${m[1]}`.toUpperCase() : '';
  }

  function cartonLabel(ct) {
    return ct?.description || ct?.name || ct?.container_number_prefix || '—';
  }

  function findContainerTypeByPackPromptLabel(label) {
    const target = normPackPromptValue(label).replace(/[{}]/g, '');
    if (!target) return null;
    const types = Session.containerTypes || [];
    for (const ct of types) {
      const values = [ct?.name, ct?.description, ct?.container_number_prefix].filter(Boolean);
      const descCode = String(ct?.description || '').match(/\{(E-\d+(?:\.\d+)?)\}/i)?.[1];
      if (descCode) values.push(descCode);
      for (const v of values) {
        const key = normPackPromptValue(v).replace(/[{}]/g, '');
        if (key && (key === target || key.includes(target) || target.includes(key))) return ct;
      }
    }
    return null;
  }

  function getExpectedCartonLabelForCurrentShipment() {
    // Mirror Pack Prompt v17.2 exactly — same field priority, same norm function.
    const sh = ShipmentCache.shipmentHeader || {};
    const ji = ShipmentCache.jobInstruction || {};
    const shipment =
      sh.shipment_number ||
      sh.shipment_no     ||
      ji.reference_number ||
      ji.job?.job_no;
    const label = shipment ? (ExpectedCartonCache.get(shipment) || null) : null;
    return label;
  }

  function getSuggestedCartonType() {
    const label = getExpectedCartonLabelForCurrentShipment();
    if (!label) return null;
    return findContainerTypeByPackPromptLabel(label);
  }

  function cartonDimsLabel(ct) {
    const l = Number(ct?.container_length || 0);
    const w = Number(ct?.container_width || 0);
    const h = Number(ct?.container_height || 0);
    return (l && w && h) ? `${l} × ${w} × ${h} cm` : 'Dimensions —';
  }

  function findContainerTypeByCartonScan(scan) {
    const target = extractCartonCode(scan);
    if (!target) return null;
    const targetNorm = target.toLowerCase();
    return (Session.containerTypes || []).find(ct => {
      const descCode = extractCartonCode(ct?.description);
      if (descCode && descCode.toLowerCase() === targetNorm) return true;
      return false;
    }) || null;
  }

  function applyCartonTypeForClose(ct) {
    if (!ct) return false;
    Session.confirmedCartonType = ct;
    Session.containerType = ct;
    if (R.lIn)  R.lIn.value  = ct.container_length  || '';
    if (R.wdIn) R.wdIn.value = ct.container_width   || '';
    if (R.htIn) R.htIn.value = ct.container_height  || '';
    if (R.wIn && !Workflow.calculateWeight()) R.wIn.value = ct.container_weight || '';
    updateCartonConfirmUI(ct, true);
    return true;
  }

  function _dimsReady() {
    if (!Workflow.requiresDimsConfirm()) return true;
    return !!(Session.confirmedCartonType && parseFloat(R.lIn?.value) > 0 && parseFloat(R.wdIn?.value) > 0 && parseFloat(R.htIn?.value) > 0);
  }

  function updateCartonConfirmUI(ct = Session.confirmedCartonType || getSuggestedCartonType(), confirmed = false) {
    const expectedLabel = !confirmed ? getExpectedCartonLabelForCurrentShipment() : null;
    const displayName = confirmed ? cartonLabel(ct) : (expectedLabel || 'UNKNOWN');
    if (R.expectedCartonName) R.expectedCartonName.textContent = displayName;
    if (R.expectedCartonDims) R.expectedCartonDims.textContent = ct ? cartonDimsLabel(ct) : 'Dimensions —';
    if (R.dimsSection) R.dimsSection.classList.toggle('mp-carton-confirmed', !!confirmed);
  }

  function showClosePrompt(statusMessage = 'All items verified — scan carton reference to apply dimensions and close.', statusType = 'idle') {
    const suggested = getSuggestedCartonType();
    updateCartonConfirmUI(Session.confirmedCartonType || suggested, !!Session.confirmedCartonType);
    if (R.dimsSection) R.dimsSection.style.display = '';
    if (R.scanSection) R.scanSection.style.display = 'none';
    if (R.btnClose) {
      R.btnClose.disabled = false;
      R.btnClose.style.opacity = '';
      R.btnClose.title = 'Scan carton reference to apply dimensions and close';
    }
    setStatus(statusMessage, statusType);
    setTimeout(() => {
      if (R.cartonScanIn) {
        R.cartonScanIn.focus();
        R.cartonScanIn.select?.();
      }
    }, 80);
  }

  async function onCartonConfirmScan(raw) {
    if (Session.phase !== 'PACKING') return;

    // Empty scan (e.g. space + Enter from a "confirm" barcode label) — treat as
    // "accept the suggested carton". This mirrors native C7 behaviour where scanning
    // the confirm label accepts whatever carton is currently suggested on screen.
    if (!raw) {
      const suggested = Session.confirmedCartonType || getSuggestedCartonType();
      if (suggested) {
        if (R.cartonScanIn) R.cartonScanIn.value = '';
        applyCartonTypeForClose(suggested);
        setStatus(`Carton confirmed: ${cartonLabel(suggested)} — closing container…`, 'ok');
        beep('ok');
        await onCloseContainer();
      } else {
        setStatus('No suggested carton — scan the E-code from the carton label.', 'err');
        beep('err');
        if (R.cartonScanIn) { R.cartonScanIn.value = ''; R.cartonScanIn.focus(); }
      }
      return;
    }

    const ct = findContainerTypeByCartonScan(raw);
    if (!ct) {
      setStatus(`Unknown carton reference "${raw}". Scan the E-code from the carton.`, 'err');
      beep('err');
      shakeStatus();
      if (R.cartonScanIn) { R.cartonScanIn.value = ''; R.cartonScanIn.focus(); }
      return;
    }
    if (R.cartonScanIn) R.cartonScanIn.value = '';
    applyCartonTypeForClose(ct);
    setStatus(`Carton confirmed: ${cartonLabel(ct)} — closing container…`, 'ok');
    beep('ok');
    await onCloseContainer();
  }

  function maybeAutoCloseAfterDims() {}

  // ─────────────────────────────────────────────────────────────────────────────
  // 16.  CLOSE CONTAINER
  // ─────────────────────────────────────────────────────────────────────────────

  function setFinalising(active, text = 'Finalising container… printing label') {
    if (!R.win) return;
    R.win.classList.toggle('finalising', !!active);
    const txt = R.win.querySelector('#mp-finalise-text');
    if (txt) txt.textContent = text;
    const disabled = !!active;
    [R.scanIn, R.toteIn, R.contNoIn, R.btnClose, R.toteBtn, R.contNoBtn].forEach(el => {
      if (el) el.disabled = disabled;
    });
  }

  async function onCloseContainer() {
    const t0 = perfNow();
    const genAtClose = _shipmentGen; // v3.3.80 — see _shipmentGen
    if (!Session.outboundContainer) { setStatus('No container open.', 'err'); return; }
    if (_requiresClosePrompt() && !_dimsReady()) {
      const hasRemaining = ShipmentCache.pendingItems.length > 0;
      const msg = hasRemaining
        ? 'Scan carton reference to apply dimensions — remaining items will continue in the next piece.'
        : 'Scan carton reference to apply dimensions, then close container.';
      showClosePrompt(msg, 'idle');
      beep('err');
      return;
    }

    R.btnClose.disabled = true;

    // Close must not race item move confirmation. SIBP showed C7 can return
    // close-to-container before a just-scanned move has committed, leaving the
    // shipment awaiting dispatch confirmation. Drain all queued/running packing
    // calls before close, even if local _apiOk flags look current.
    if (Q._running > 0 || Q._queue.length > 0) {
      const drainStart = perfNow();
      setStatus('Waiting for item moves to confirm before closing…', 'loading');
      await Q.drain();
      perfMark('API queue drain before close', drainStart);
    }

    const unconfirmedDone = ShipmentCache.allItems.filter(t => t.done && !t._apiOk);
    if (unconfirmedDone.length) {
      setStatus(`Waiting for ${unconfirmedDone.length} item move(s) to confirm before closing…`, 'loading');
      await Q.drain();
    }
    const stillUnconfirmed = ShipmentCache.allItems.filter(t => t.done && !t._apiOk);
    if (stillUnconfirmed.length) {
      setStatus('Cannot close yet — item move confirmation is still pending.', 'err');
      R.btnClose.disabled = false;
      updateCloseButtonReady();
      return;
    }

    const remainingBeforeClose = ShipmentCache.pendingItems.length;

    Session.phase = 'CLOSING';
    try {
      const ct = Session.confirmedCartonType || Session.containerType;

      // Calculate weight using ONLY items scanned in this container.
      // We can't rely on flags set after close (chicken-and-egg), so instead
      // we capture the current-piece weight directly: sum scanned items that
      // are done and confirmed (_apiOk) in this piece, excluding anything
      // marked _closedInPreviousPiece from a prior piece close.
      const calcedWeight = Workflow.calcPackedWeight();
      const weight = Math.max(
        calcedWeight || ct?.container_weight || 0,
        0.1
      );
      const length = Math.max(parseFloat(R.lIn?.value)  || ct?.container_length  || 0, 1);
      const width  = Math.max(parseFloat(R.wdIn?.value) || ct?.container_width   || 0, 1);
      const height = Math.max(parseFloat(R.htIn?.value) || ct?.container_height  || 0, 1);

      setFinalising(true, 'Finalising container…');
      setStatus('Closing container…', 'loading');
      const closeResp = await closeContainer(weight, length, width, height);
      perfMark('all scanned to close response', t0);

      if (closeResp._softError) {
        console.warn('[MalpaPack] close-to-container soft error:', closeResp._softError);
        setStatus(`⚠ Close warning: ${closeResp._softError} — proceeding to consign.`, 'warn');
      }

      // Consignment ID: prefer from close response, fall back to cached header.
      const consId = closeResp?.consignment_id
        || closeResp?.shipmentHeader?.consignment_id
        || ShipmentCache.shipmentHeader?.consignment_id;

      // Capture the shipment number NOW, while ShipmentCache is still populated.
      // The consign-error catch below fires asynchronously — often AFTER
      // resetForNextTote() has cleared the cache (especially on MIBP, where the
      // retained-tote auto-load races the label calls). Reading the cache inside
      // the catch returned undefined and fell back to consId — which is how the
      // consignment ID ended up in the shipment badge. Never fall back to consId.
      const shipNoForBadge = ShipmentCache.shipmentHeader?.shipment_number || null;

      // Start post-close work only after close-to-container has completed so C7 has
      // committed final weight/dimensions. For SIBP, move back to the item-scan
      // screen immediately but keep scanning locked until this promise settles.
      if (consId) {
        _lastConsignmentId = consId;
        if (R.reprintBtn) {
          R.reprintBtn.disabled = false;
          R.reprintBtn.title = `Reprint label for consignment ${consId}`;
        }
      }
      EventLog.ok(`Container ${Session.outboundContainer?.container_no || ''} closed.`);
      Session.phase = 'COMPLETE';

      if (remainingBeforeClose > 0 && ShipmentCache.pendingItems.length > 0) {
        // Mid-shipment close — items still remain for the next container.
        // Mark scanned items as belonging to the just-closed piece so
        // calcPackedWeight excludes them from future piece weight calculations.
        for (const track of ShipmentCache.allItems) {
          // Snapshot the committed unit count — the floor below which UNDO is
          // locked, and the baseline for the next piece's weight delta.
          if ((track.scanned || 0) > 0) track._scannedAtPieceStart = track.scanned;
          if (track.done && track._apiOk) {
            track._closedInPreviousPiece = true;
            track._closedContainerNo = Session.outboundContainer?.container_no || null;
          }
        }
        setFinalising(false);
        unlockScanAfterFinalising();
        setStatus('Container closed — creating next piece…', 'ok');
        onNewContainer();
      } else {
        // Final close — all items packed. Now consign and print label.
        setFinalising(true, 'All items packed — printing label…');
        // v3.3.80: consign chain goes through the FIFO queue so it can never
        // run concurrently with (or print ahead of) another shipment's chain.
        const postCloseCallsReady = _enqueueConsign(() => startPostCloseConsigning(consId, closeResp));
        EventLog.ok('All items packed — label printing.');
        postCloseCallsReady.catch(err => {
          // Always surface the failure loudly — badge, log, beep, reprint —
          // even if the operator has already moved on to the next shipment.
          const shipNo = shipNoForBadge || '—';
          updateShipBadge(shipNo, true);
          const msg = err.message || 'Unknown error';
          setStatus(`⚠ Label failed for ${shipNo}: ${msg}. Fix the shipment in C7 then use ⟳ Reprint.`, 'err');
          EventLog.err(`Consign failed for ${shipNo}: ${msg}`);
          beep('err');
          if (R.reprintBtn && consId) { R.reprintBtn.disabled = false; }
          // v3.3.80: state/UI mutations only if no newer shipment has loaded —
          // otherwise these would clobber the shipment the operator is packing.
          if (_shipmentGen === genAtClose) {
            setFinalising(false);
            unlockScanAfterFinalising();
            Session.phase = 'COMPLETE';
            if (R.btnClose) { R.btnClose.disabled = true; R.btnClose.style.opacity = '.55'; }
          }
        });
        resetForNextTote(postCloseCallsReady, t0);
      }
    } catch (err) {
      // Hard errors only reach here (auth failure, network down, unexpected server error).
      // "No Print Route" is caught in the inner try blocks above and never reaches here.
      setFinalising(false);
      unlockScanAfterFinalising();
      setStatus(`Close error: ${err.message}`, 'err');
      EventLog.err(`Close container failed: ${err.message}`);
      beep('err');
      Session.phase = 'PACKING';
    }
    if (Session.phase === 'PACKING') R.btnClose.disabled = false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 17.  NEW CONTAINER (same shipment, remaining items continue)
  // ─────────────────────────────────────────────────────────────────────────────

  function onNewContainer() {
    if (Session.phase !== 'COMPLETE' && Session.phase !== 'PACKING') return;
    // Reset only the outbound container session; shipment cache persists
    Session.containerType     = null;
    Session.confirmedCartonType = null;
    Session.outboundContainer = null;
    Session._currentPieceScannedQty = 0; // reset per-piece scan counter for weight calc
    _selBoxEl = null;
    if (R.newContCard)   R.newContCard.style.display   = 'none';
    if (R.dimsSection)   R.dimsSection.style.display   = 'none';
    if (R.scanSection)   R.scanSection.style.display   = 'none';
    if (R.progWrap)      R.progWrap.style.display      = 'none';
    if (R.actSection)    R.actSection.style.display    = 'none';
    if (R.rollbackBanner) R.rollbackBanner.style.display = 'none';
    Session.phase = 'CHOOSE_BOX';
    setStatus('Creating next outbound container…', 'idle');
    initiateContainerCreation();
  }

  // Pack short is now integrated into onCloseContainer — no standalone function needed.

  // ─────────────────────────────────────────────────────────────────────────────
  // 19.  PRINT LABEL
  // ─────────────────────────────────────────────────────────────────────────────

  // Print Label removed — consigning is handled automatically on Close Container.

  // ─────────────────────────────────────────────────────────────────────────────
  // 20.  FULL RESET
  // ─────────────────────────────────────────────────────────────────────────────

  function onFullReset() {
    // If an outbound container was created but never closed, delete it from C7
    // so it doesn't appear as an empty orphan at consigning time.
    maybeDeleteAbandonedContainer();

    Session.resetAll();
    ShipmentCache.clear();
    SourceToteCache.clear();
    EventLog.clear();
    _selBoxEl = null;
    if (!R.toteIn) return;

    clearRetainedToteNumber();
    R.toteIn.value  = '';
    R.scanIn.value  = '';
    R.contNoIn.value = '';

    const hide = [
      R.toteSection, R.shipCard, R.boxSection, R.contNoSection,
      R.newContCard, R.dimsSection, R.scanSection, R.progWrap, R.rollbackBanner,
    ];
    hide.forEach(el => { if (el) el.style.display = 'none'; });
    if (R.actSection) { R.actSection.style.display = 'none'; R.actSection.style.flexDirection = ''; }
    if (R.progBar)    R.progBar.style.width = '0%';
    if (R.btnClose)   { R.btnClose.disabled = false; R.btnClose.style.opacity = ''; R.btnClose.title = ''; }
    if (R.boxList)    R.boxList.innerHTML = '';
    if (R.dcPanel)    R.dcPanel.style.display = 'none';
    _containerEmptyShown = false;
    _currentJobId = null;
    if (R.unassignBtn) {
      R.unassignBtn.disabled = true;
      R.unassignBtn.classList.remove('mp-unassign-alert');
      R.unassignBtn.title = 'No job loaded — scan a tote first';
      R.unassignBtn.textContent = '⛔ Unassign Job';
    }

    // Clear picker badge on full reset
    updatePickerBadge(null);

    renderItems('');
    setStatus('Select profile and scan a tote to begin', 'idle');
    ['mp-f-prof','mp-f-cont','mp-f-ship'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });

    // Re-enable profile + location selectors
    if (R.profSel) R.profSel.disabled = false;
    if (R.locBtn)  R.locBtn.disabled  = false;
    if (R.locIn)   R.locIn.disabled   = false;
    // Re-reveal tote scan if profile & location still set
    if (Session.profile && Session.packLocationId) revealToteScan();
  }

  /**
   * resetForNextTote — called automatically after a successful close.
   * Clears shipment data and container state but RETAINS:
   *   - packing profile
   *   - pack-to location
   *   - container types cache
   * Returns the UI to the tote scan step, ready for the next shipment.
   */
  function resetForNextTote(postCloseCallsReady = Promise.resolve(), closeStartedAt = null) {
    // Preserve the shipment number across consign — only overwrite when a new
    // shipment loads. Store before clearing so the badge stays correct.
    const _lastShipmentNo = ShipmentCache.shipmentHeader?.shipment_number || null;

    // Preserve profile + location — only clear shipment/container state
    Session.containerType     = null;
    Session.confirmedCartonType = null;
    // OPT3: containerTypes intentionally kept — warehouse config doesn't change mid-shift.
    // Saves ~350ms off every tote load after the first.
    Session.outboundContainer = null;
    Session.phase             = Workflow.usesItemInitiatedFlow() ? 'SIBP_ITEM_SCAN' : 'SCAN_TOTE';
    ShipmentCache.clear();
    // EventLog intentionally NOT cleared here — log persists after consign so
    // operators can review what happened if errors are detected post-shipment.
    // Log is cleared only when a new tote is scanned (see loadTote).
    _selBoxEl = null;
    _containerEmptyShown = false;
    _currentJobId = null;
    if (R.unassignBtn) {
      R.unassignBtn.disabled = true;
      R.unassignBtn.classList.remove('mp-unassign-alert');
      R.unassignBtn.title = 'No job loaded — scan a tote first';
      R.unassignBtn.textContent = '⛔ Unassign Job';
    }

    // Restore shipment number badge — keep showing the last shipment number
    // until a new shipment loads. Prevents the consignment ID overwriting it.
    if (_lastShipmentNo) updateShipBadge(_lastShipmentNo);

    // Picker badge intentionally kept after consign — operators need to see
    // who picked the job even after the shipment is closed, since errors are
    // often detected after consigning. Badge only clears when a new tote loads.
    // updatePickerBadge(null); ← removed

    if (!R.toteIn) return;

    if (!Workflow.usesItemInitiatedFlow()) {
      setFinalising(false);
      unlockScanAfterFinalising();
    }

    // MIBP uses one physical source tote for multiple shipments; keep the tote number
    // only while the tote-wide detail counter still has work remaining.
    const detailsRemaining = getDetailsRemaining();
    const shouldRetain = R.retainChk && (R.retainChk.checked || Workflow.usesRetainedSourceFlow());

    // For MIBP: only retain if the tote still has items remaining across shipments.
    // For standard profiles with retain checkbox: always retain if checked —
    // detailsRemaining is 0 here because ShipmentCache was just cleared.
    const doRetain = shouldRetain && (
      Workflow.usesRetainedSourceFlow() ? detailsRemaining > 0 : true
    );
    if (Workflow.usesRetainedSourceFlow() && R.retainChk) {
      R.retainChk.checked = true;
      localStorage.setItem(RETAIN_TOTE_ENABLED_KEY, '1');
    }
    if (Workflow.usesItemInitiatedFlow()) {
      const retainedSource = Session.sibpSourceContainerNo || R.toteIn.value;
      Session.sibpSourceContainerNo = retainedSource;
      Session.sibpProcessing = true;
      R.toteIn.value = retainedSource;
      R.scanIn.value = '';
      R.contNoIn.value = '';
      _autoReloadAfterClose = false;
      const hide = [
        R.shipCard, R.boxSection, R.contNoSection,
        R.newContCard, R.dimsSection, R.progWrap, R.rollbackBanner,
      ];
      hide.forEach(el => { if (el) el.style.display = 'none'; });
      if (R.actSection) R.actSection.style.display = 'none';
      if (R.scanSection) R.scanSection.style.display = '';
      renderItems('');
      updateDetailCounter();
      updateFooter();
      setSibpItemScanEnabled(false);
      setStatus('✓ Shipment complete — processing container. Wait before scanning next item…', 'loading');
      Promise.resolve(postCloseCallsReady)
        .finally(() => {
          setFinalising(false);
          unlockScanAfterFinalising();
          Session.sibpProcessing = false;
          const remainingAfterClose = getDetailsRemaining();
          if (remainingAfterClose <= 0) {
            Session.phase = 'SCAN_TOTE';
            Session.sibpSourceContainerNo = null;
            SourceToteCache.clear();
            clearRetainedToteNumber();
            if (R.retainChk) {
              R.retainChk.checked = false;
              localStorage.setItem(RETAIN_TOTE_ENABLED_KEY, '0');
            }
            if (R.toteIn) R.toteIn.value = '';
            if (R.scanIn) R.scanIn.value = '';
            if (R.scanSection) R.scanSection.style.display = 'none';
            if (R.toteSection) R.toteSection.style.display = '';
            if (R.dcPanel) R.dcPanel.style.display = 'none';
            updateFooter();
            perfMark('SIBP close to source tote complete', closeStartedAt);
            setStatus('✓ Source tote complete — scan next source container.', 'ok');
            setTimeout(() => R.toteIn && R.toteIn.focus(), 80);
            return;
          }
          Session.phase = 'SIBP_ITEM_SCAN';
          setSibpItemScanEnabled(true);
          // Refresh the inventory counter — items were just consumed from the tote
          loadToteInventoryDetailsInBackground(Session.sibpSourceContainerNo, { label: 'SIBP post-close refresh' });
          updateDetailCounter();
          perfMark('SIBP close to next item unlocked', closeStartedAt);
          setStatus('✓ Container finished — scan any item from the same SIBP cart.', 'ok');
        });
      return;
    }
    const retained = doRetain ? R.toteIn.value : '';
    if (retained) rememberRetainedTote(retained);
    else clearRetainedToteNumber();
    _autoReloadAfterClose = !!retained;
    R.toteIn.value   = retained;
    R.scanIn.value   = '';
    R.contNoIn.value = '';

    // Hide all shipment/container/packing sections
    const hide = [
      R.shipCard, R.boxSection, R.contNoSection,
      R.newContCard, R.dimsSection, R.scanSection,
      R.progWrap, R.rollbackBanner,
    ];
    hide.forEach(el => { if (el) el.style.display = 'none'; });
    if (R.actSection) R.actSection.style.display = 'none';
    if (R.progBar)    R.progBar.style.width = '0%';
    if (R.btnClose)   R.btnClose.disabled = false;
    if (R.boxList)    R.boxList.innerHTML = '';
    renderItems('');
    if (R.dcPanel) {
      if (Workflow.usesRetainedSourceFlow() && SourceToteCache.allItems.length) updateDetailCounter();
      else R.dcPanel.style.display = 'none';
    }
    updateFooter();

    // Re-enable tote input and focus it for next scan
    R.toteBtn.disabled = false;
    if (R.profSel) R.profSel.disabled = false;
    if (R.locBtn)  R.locBtn.disabled  = false;
    if (R.locIn)   R.locIn.disabled   = false;

    // Tote section stays visible (profile + location are still set)
    R.toteSection.style.display = '';
    setTimeout(() => {
      if (!R.toteIn) return;
      R.toteIn.focus();
      if (_autoReloadAfterClose && retained) {
        _autoReloadAfterClose = false;
        // v3.3.80: OVERLAP — load the next shipment immediately instead of
        // waiting ~8s for the previous shipment's consign/label chain. The
        // chain runs behind the operator; the consign FIFO guarantees chains
        // never run concurrently or print out of order, and a label failure
        // is surfaced by the onCloseContainer handler (badge + log + beep +
        // ⟳ Reprint) even while the next shipment is being packed.
        setStatus('✓ Shipment complete — label printing in background, loading next shipment…', 'ok');
        Promise.resolve(postCloseCallsReady).catch(() => {}); // surfaced upstream
        maybeAutoLoadRetainedTote('after-close');
      } else if (shouldRetain && retained) {
        // If retaining but not auto-loading, select all text so operator can overwrite or press Load
        R.toteIn.select();
        R.toteIn.style.transition = 'border-color 0.1s';
        R.toteIn.style.borderColor = 'var(--c7-teal)';
        setTimeout(() => { if (R.toteIn) R.toteIn.style.borderColor = ''; }, 800);
      } else {
        // Brief amber pulse to draw the operator's eye
        R.toteIn.style.transition = 'border-color 0.1s';
        R.toteIn.style.borderColor = 'var(--mp-amber)';
        setTimeout(() => { if (R.toteIn) R.toteIn.style.borderColor = ''; }, 800);
      }
    }, 150);

    setStatus(retained
      ? '✓ Shipment complete — retained tote queued. Waiting for close/consigning calls…'
      : '✓ Shipment complete — scan next tote to begin.', 'ok');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 21.  RENDER FUNCTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  function renderShipCard() {
    const sh = ShipmentCache.shipmentHeader;
    if (!sh || !R.shipCard) return;
    R.shipCard.innerHTML = '';
    R.shipCard.style.display = '';
    R.shipCard.classList.add('mp-ship-card');

    const toggle = h('button', { cls: 'mp-ship-toggle', type: 'button' });
    toggle.append(h('span', {}, 'Shipment Information'), h('span', { cls: 'arr' }, '▼'));
    const body = h('div', { cls: 'mp-ship-body' });
    toggle.addEventListener('click', () => R.shipCard.classList.toggle('open'));

    const rows = [
      ['Order #',   sh.shipment_number, 'hi order'],
      ['Customer',  sh.address?.ship_to_name || sh.customer_code || '—', ''],
      ['Company',   ShipmentCache.company?.company_code || '—', ''],
      ['Carrier',   sh.carrier?.name || '—', 'blue'],
      ['Service',   sh.carrierService?.name || '—', ''],
      ['Total Qty', String(sh.total_quantity || ShipmentCache.allItems.length), 'green'],
    ];
    for (const [k, v, cls] of rows) {
      const r = h('div', { cls: 'mp-crow' });
      r.append(h('span', { cls: 'mp-ck' }, k), h('span', { cls: `mp-cv${cls ? ' ' + cls : ''}` }, String(v)));
      body.append(r);
    }
    R.shipCard.append(toggle, body);
    updateFooter();
  }

  function renderNewContCard() {
    if (!R.newContCard) return;
    R.newContCard.innerHTML = '';
    R.newContCard.style.display = 'none';
  }

  /**
   * Efficient item list renderer.
   * Uses per-row update instead of full innerHTML wipe when possible.
   */
  /**
   * renderItems — full stateless redraw on every call.
   * Simpler and bug-free compared to surgical patching;
   * performance is more than adequate for typical shipment sizes (<200 lines).
   */
  /**
   * renderLoadingItems — v3.3.82 perceived-speed skeleton.
   * Shown the instant a tote/item is scanned, replaced by renderItems() when
   * GPC returns. Purely visual — the operator sees immediate feedback instead
   * of a dead panel during the ~1-2s GPC round-trip.
   */
  function renderLoadingItems(label = '') {
    if (!R.list) return;
    R.list.innerHTML = '';
    const note = h('div', { cls: 'mp-skel-loading-note' },
      `Loading shipment${label ? ` for ${label}` : ''}…`);
    R.list.append(note);
    for (let i = 0; i < 4; i++) {
      const row  = h('div', { cls: 'mp-skel-row' });
      const info = h('div', { cls: 'mp-skel-info' });
      const name = h('div', { cls: 'mp-skel' });
      name.style.cssText = `height:16px;width:${55 + (i * 7) % 25}%`;
      const sku  = h('div', { cls: 'mp-skel' });
      sku.style.cssText = `height:12px;width:${22 + (i * 5) % 14}%`;
      info.append(name, sku);
      const qty = h('div', { cls: 'mp-skel' });
      qty.style.cssText = 'height:28px;width:64px;flex-shrink:0';
      row.append(info, qty);
      R.list.append(row);
    }
    if (R.rhCnt) R.rhCnt.textContent = '…';
  }

  function renderItems(filter = '') {
    if (!R.list) return;
    const fl     = (filter || '').toLowerCase();
    const tracks = ShipmentCache.allItems;

    R.list.innerHTML = '';

    if (!tracks.length) {
      const e = h('div', { cls: 'mp-empty' });
      e.innerHTML = Workflow.usesItemInitiatedFlow() && Session.phase === 'SIBP_ITEM_SCAN'
        ? `<div class="ico">📦</div>
        <div class="t">SIBP Source Loaded</div>
        <div class="s">Scan any item from this cart to load and consign its shipment</div>`
        : `<div class="ico">📦</div>
        <div class="t">No Container Loaded</div>
        <div class="s">Select a packing profile and scan a tote to begin</div>`;
      R.list.append(e);
      if (R.rhCnt) R.rhCnt.textContent = '—';
      return;
    }

    let shown = 0;

    for (const track of tracks) {
      const child  = track.child;
      const detail = child.shipmentDetail;
      const item   = detail?.item;
      const name   = item?.description || item?.long_description || item?.item_code || '—';
      const sku    = item?.item_code || '—';
      const sourceContainerNo = String(track.sourceContainerNo || '—');

      if (fl && !name.toLowerCase().includes(fl) && !sku.toLowerCase().includes(fl) && !sourceContainerNo.toLowerCase().includes(fl)) continue;

      const st     = track.done ? 'done' : track.scanned > 0 ? 'partial' : 'pending';

      const row = h('div', {
        cls: 'mp-item ' + st,
        id:  'mp-item-' + child.id,
        'data-child-id': String(child.id),
      });

      // Click behaviour — undo if has scans, focus scan input if pending
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('mp-undo')) return;
        const canUndo = (track.scanned || 0) > (track._scannedAtPieceStart || 0);
        if (canUndo && (track.done || track.scanned > 0)) {
          unverifyItem(track);
        } else {
          R.scanIn && R.scanIn.focus();
        }
      });

      // ── Item info column ───────────────────────────────────────────────
      const infoCol = h('div', { cls: 'mp-item-info' });
      infoCol.append(
        h('div', { cls: 'mp-iname' }, name),
        h('div', { cls: 'mp-isku'  }, sku),
      );
      if (track.sourceContainerNo) {
        infoCol.append(h('div', { cls: 'mp-icontainer', title: 'Source container / tote' }, `Tote ${track.sourceContainerNo}`));
      }

      // ── Quantity column ────────────────────────────────────────────────
      const qtyCol  = h('div', { cls: 'mp-item-qty' });
      const qtyMain = h('div', { cls: 'mp-iqty-main' }, String(track.scanned));
      const qtySep  = h('div', { cls: 'mp-iqty-sep' }, '/');
      const qtyOf   = h('div', { cls: 'mp-iqty-of'  }, String(track.required));
      qtyCol.append(qtyMain, qtySep, qtyOf);

      const _floor = track._scannedAtPieceStart || 0;
      const _undoable = (track.scanned || 0) > _floor;
      if (!_undoable && (track.scanned || 0) > 0) {
        // Everything scanned on this line is committed to a closed container.
        const locked = h('span', {
          cls: 'mp-locked-label',
          title: track._closedContainerNo
            ? `Packed in closed container ${track._closedContainerNo} — cannot be unverified`
            : 'Committed to a closed container — cannot be unverified',
        }, track._closedContainerNo ? `🔒 ${track._closedContainerNo}` : '🔒 CLOSED');
        qtyCol.append(locked);
      } else if (track.scanned > 0 || track.done) {
        const undo = h('button', { cls: 'mp-undo' }, 'UNDO');
        undo.addEventListener('click', e => { e.stopPropagation(); unverifyItem(track); });
        qtyCol.append(undo);
      }

      // ── Verified badge (shows on done rows) ───────────────────────────
      const badge = h('span', { cls: 'mp-verified-label' }, '✓ VERIFIED');
      row.append(infoCol, qtyCol, badge);
      R.list.append(row);
      shown++;
    }

    if (R.rhCnt) R.rhCnt.textContent = shown;
  }

  function unverifyItem(track) {
    // Units committed by a previous container close are locked — they are
    // physically inside a sealed, weighed box and C7 has no reverse move.
    // Only units scanned in the CURRENT piece can be undone.
    const committedFloor = track._scannedAtPieceStart || 0;
    if ((track.scanned || 0) <= committedFloor) {
      setStatus(
        track._closedContainerNo
          ? `⚠ Already packed in closed container ${track._closedContainerNo} — cannot be unverified.`
          : '⚠ Already committed to a closed container — cannot be unverified.',
        'err'
      );
      beep('err');
      return;
    }
    track.scanned--;
    if (Session._currentPieceScannedQty > 0) Session._currentPieceScannedQty--;
    if (track.scanned < track.required) track.done = false;

    // If the operator undoes a line after the carton dimensions prompt appears,
    // return them to item scanning. Otherwise they are stuck in dimensions mode
    // with no visible way to re-verify the item.
    if (Session.phase === 'PACKING' && !ShipmentCache.allDone) {
      if (R.dimsSection) R.dimsSection.style.display = 'none';
      if (R.scanSection) R.scanSection.style.display = '';
      if (R.btnClose) {
        R.btnClose.disabled = false;
        R.btnClose.style.opacity = '';
        R.btnClose.title = 'Close this container and continue remaining items in another piece';
      }
      setTimeout(() => R.scanIn && R.scanIn.focus(), 80);
    }

    setStatus('Item de-scanned — rescan to re-pack.', 'idle');
    updateProgress();
    updateDetailCounter();
    renderItems(R.rhFil?.value || '');
  }

  function updateProgress() {
    if (!R.progBar) return;
    const pct = ShipmentCache.pct;
    R.progBar.style.width = pct + '%';
    R.progBar.className   = 'mp-progb' + (pct >= 100 ? ' full' : '');
  }

  let _containerEmptyShown = false;

  /**
   * updateDetailCounter — updates the titlebar pill and its popover rows.
   * Shows per-SKU remaining qty, ticks down as items are scanned.
   * When all reach 0, fires the completion sound + popup (once per container session).
   */
  function updateDetailCounter() {
    if (!R.dcPanel || !R.dcTotal || !R.dcBody) return;
    const tracks = (Workflow.usesRetainedSourceFlow() || Workflow.usesItemInitiatedFlow()) && SourceToteCache.allItems.length
      ? SourceToteCache.allItems
      : ShipmentCache.allItems;
    if (!tracks.length) {
      R.dcPanel.style.display = 'none';
      if (R.dcPopover) R.dcPopover.style.display = 'none';
      _containerEmptyShown = false;
      return;
    }

    R.dcPanel.style.display = 'inline-flex'; // pill is inline-flex

    // Build popover rows — one per SKU line, showing remaining qty
    R.dcBody.innerHTML = '';
    let totalRemaining = 0;

    for (const track of tracks) {
      const remaining = track.required - track.scanned;
      totalRemaining += Math.max(0, remaining);
      const allDone = remaining <= 0;

      const row = h('div', { cls: 'mp-dc-row' + (allDone ? ' all-done' : '') });
      const skuEl = h('div', { cls: 'mp-dc-row-sku' }, track.sku);
      skuEl.title = track.name; // full name on hover
      const qtyEl = h('div', { cls: 'mp-dc-row-qty' + (allDone ? ' done' : '') },
        allDone ? '✓' : String(remaining)
      );
      row.append(skuEl, qtyEl);
      R.dcBody.append(row);
    }

    // Update pill total
    R.dcTotal.textContent = String(totalRemaining);
    R.dcTotal.className   = 'mp-dc-pill-total' + (totalRemaining === 0 ? ' zero' : '');

    // For retained-source MIBP, zero here can mean current loaded shipment is complete, not the whole tote.
    // Keep retain active and avoid claiming the physical source tote is empty without a
    // verified tote-wide API response.
    if (Workflow.usesRetainedSourceFlow()) return;

    // Fire completion when container hits zero — only once per container load
    if (totalRemaining === 0 && !_containerEmptyShown && Session.phase === 'PACKING') {
      _containerEmptyShown = true;
      showContainerEmptyPopup();
    }
  }

  function showContainerEmptyPopup() {
    // Overlay
    const overlay = h('div', { cls: 'mp-popup-overlay' });
    // Popup
    const popup = h('div', { cls: 'mp-empty-popup' });
    popup.innerHTML = `
      <div class="mp-empty-popup-icon">🎉</div>
      <div class="mp-empty-popup-title">Container Empty!</div>
      <div class="mp-empty-popup-sub">All items in this container have been packed.</div>`;
    const dismissBtn = h('button', { cls: 'mp-empty-popup-dismiss' }, 'Continue →');

    dismissBtn.addEventListener('click', () => {
      overlay.remove();
      popup.remove();
      // Only non-retained-source flows can safely treat this as the physical source tote being empty.
      if (R.retainChk && !Workflow.usesRetainedSourceFlow()) {
        R.retainChk.checked = false;
        localStorage.setItem(RETAIN_TOTE_ENABLED_KEY, '0');
        clearRetainedToteNumber();
      }
    });

    popup.append(dismissBtn);
    document.body.append(overlay, popup);

    // Brief confirmation only — do not block the next scan/dimensions action.
    setTimeout(() => { overlay.remove(); popup.remove(); }, 1000);
  }

  function updateFooter() {
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val || '—';
    };
    set('mp-f-prof', Session.profile?.name);
    set('mp-f-cont', Session.outboundContainer?.container_no);
    set('mp-f-ship', ShipmentCache.shipmentHeader?.shipment_number);
  }

  function flashRow(childId, cls) {
    const el = document.getElementById(`mp-item-${childId}`);
    if (!el) return;
    el.classList.remove('fG', 'fA', 'rollback');
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 500);
  }

  function scrollIntoView(childId) {
    const el = document.getElementById(`mp-item-${childId}`);
    el && el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function shakeStatus() {
    if (!R.statusEl) return;
    R.statusEl.style.transition = 'none';
    R.statusEl.style.transform  = 'translateX(-5px)';
    setTimeout(() => { R.statusEl.style.transition = ''; R.statusEl.style.transform = ''; }, 80);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 22.  KEYBOARD
  // ─────────────────────────────────────────────────────────────────────────────

  function onGlobalKey(e) {
    if (!R.overlay) return;
    if (e.key === 'Escape') { closeUI(); return; }
    if (e.key === 'F2')  { e.preventDefault(); R.scanIn && R.scanIn.focus(); }
    if (e.key === 'F3')  { e.preventDefault(); R.toteIn && R.toteIn.focus(); }
    if (e.key === 'F4')  { e.preventDefault(); onCloseContainer(); }
    // Enter fires Close Container only when it's enabled (all items verified)
    if (e.key === 'Enter' && Session.phase === 'PACKING') {
      const active = document.activeElement;
      // Don't intercept Enter when operator is typing in an input field
      const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (!isInput && R.btnClose && !R.btnClose.disabled) {
        e.preventDefault();
        onCloseContainer();
      }
    }
  }

  function closeUI() {
    // Clean up any open outbound container that was never closed
    maybeDeleteAbandonedContainer();
    resetRetainedToteState();

    document.removeEventListener('keydown', onGlobalKey);
    if (window._mpTabPoll) { clearInterval(window._mpTabPoll); window._mpTabPoll = null; }
    if (window._mpTabObserver) { window._mpTabObserver.disconnect(); window._mpTabObserver = null; }
    clearInterval(_queuePollInterval);
    R.overlay && R.overlay.remove();
    document.getElementById('mp-tab-li')?.remove();
    // Reactivate the last C7 tab
    const tabBar = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    if (tabBar) {
      const lastLi = tabBar.querySelector('li.nav-item:last-child');
      if (lastLi) {
        lastLi.classList.add('active');
        const a = lastLi.querySelector('a.nav-link');
        if (a) { a.classList.add('active'); a.setAttribute('aria-selected','true'); }
      }
    }
    // Reactivate the last content tab
    const tabContent = document.querySelector('div.tab-content');
    if (tabContent) {
      const panels = tabContent.querySelectorAll(':scope > tab, :scope > .tab-pane');
      if (panels.length) {
        const last = panels[panels.length - 1];
        last.classList.add('active');
        last.style.display = '';
      }
    }
    R = {};
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 23.  NAV INJECTION
  // ─────────────────────────────────────────────────────────────────────────────

  // Single document-level capture listener — survives Angular re-rendering
  // the nav, because the document itself is never re-rendered.
  let _navClickAttached = false;
  function _attachNavClickListener() {
    if (_navClickAttached) return;
    _navClickAttached = true;
    document.addEventListener('click', (e) => {
      // Check if click was on or inside our nav element
      const nav = document.getElementById('mp-nav');
      if (!nav) return;
      if (nav === e.target || nav.contains(e.target)) {
            openPack();
      }
    }, true); // capture phase — fires before Angular
  }

  function injectNav() {
    // Attach the document-level click listener once (survives Angular re-renders)
    _attachNavClickListener();

    if (document.getElementById('mp-nav')) return;
    const ul = document.querySelector('div.sidebar nav ul.nav');
    if (!ul) return;

    const li = document.createElement('li');
    li.id        = 'mp-nav-li';
    li.className = 'nav-item ng-star-inserted';

    const a = document.createElement('a');
    a.id        = 'mp-nav';
    a.className = 'nav-link ng-star-inserted';
    a.setAttribute('href', 'javascript:void(0)');
    a.innerHTML = `
      <span class="mp-nav-icon"><img src="data:image/png;base64,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" onerror="this.style.display='none'" style="width:20px;height:20px;border-radius:4px;object-fit:contain"/></span>
      <span class="mp-nav-label">Malpa Pack</span>`;

    li.append(a);
    ul.insertBefore(li, ul.firstChild);
  }

  function openPack() {
    if (document.getElementById('mp-tab-view') || document.getElementById('mp-tab-li')) return;
    try {
      injectCSS();
      buildUI();
    } catch(err) {
      console.error('[MalpaPack] openPack error:', err);
      // Show a visible alert so the error surfaces even without DevTools open
      const errDiv = document.createElement('div');
      errDiv.style.cssText = 'position:fixed;top:80px;left:210px;right:20px;z-index:99999;background:#7f1d1d;color:#fff;padding:16px 20px;border-radius:6px;font-family:monospace;font-size:13px;white-space:pre-wrap;';
      errDiv.textContent = '[MalpaPack Error] ' + err.message + '\n\n' + err.stack;
      const cls = document.createElement('button');
      cls.textContent = '×'; cls.style.cssText = 'float:right;background:none;border:none;color:#fff;font-size:20px;cursor:pointer;margin:-4px -4px 0 0;';
      cls.onclick = () => errDiv.remove();
      errDiv.prepend(cls);
      document.body.append(errDiv);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 24.  BOOT
  // ─────────────────────────────────────────────────────────────────────────────

  window.addEventListener('beforeunload', resetRetainedToteState);

  let _attempts = 0;
  function tryInject() {
    if (document.querySelector('div.sidebar nav li.nav-item')) {
      injectCSS();
      injectNav();
      return;
    }
    if (++_attempts < 80) setTimeout(tryInject, 500);
  }

  new MutationObserver(() => {
    if (!document.getElementById('mp-nav') && document.querySelector('div.sidebar nav li.nav-item')) {
      injectNav();
    }
  }).observe(document.body, { childList: true, subtree: true });

  // OPT5: Patch XHR at boot time.
  captureSessionId();

  // Pre-resolve pack-to location in the background before the tab is opened.
  // Waits for _sessionId to be captured first (via XHR intercept) so API calls
  // don't stall in waitForSession() — avoids up to 1s unnecessary delay.
  let _preloadedLocation = null;
  let _preloadedLocationId = null;

  (function _bootLocationResolve() {
    // If session already captured, resolve immediately
    if (_sessionId) {
      _doResolveLocation();
      return;
    }
    // Otherwise wait up to 5s for the first Angular XHR to be intercepted
    let _tries = 0;
    const _poll = setInterval(() => {
      if (_sessionId || ++_tries > 50) {
        clearInterval(_poll);
        _doResolveLocation();
      }
    }, 100);
  })();

  function _doResolveLocation() {
    autoDetectLocation()
      .then(code => {
        if (!code) return;
        _preloadedLocation = code;
        return fetchLocationByCode(code);
      })
      .then(loc => {
        if (!loc) return;
        _preloadedLocationId = loc.id;
        _preloadedLocation   = loc.location_code;
          })
      .catch(() => {});
  }

  tryInject();

})();
