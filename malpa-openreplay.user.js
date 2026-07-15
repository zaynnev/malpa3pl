// ==UserScript==
// @name         Malpa OpenReplay Ingest Redirect
// @namespace    malpa.openreplay
// @version      0.3.0
// @description  Redirect Canary7's built-in OpenReplay tracker to Malpa's self-hosted box (host + project-key swap), including the Web Worker that uploads session data.
// @match        https://malpa.canary7.com/*
// @match        https://*.canary7.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/REPLACE-USER/REPLACE-REPO/main/malpa-openreplay-redirect.user.js
// @downloadURL  https://raw.githubusercontent.com/REPLACE-USER/REPLACE-REPO/main/malpa-openreplay-redirect.user.js
// ==/UserScript==

/*
 * WHAT THIS DOES
 * --------------
 * Canary7 embeds the OpenReplay tracker on every page. It targets the dead host
 * openreplay.canary7.com using C7's own (rejected) project key. OpenReplay allows
 * only ONE tracker per page, so we can't run our own. Instead we hijack C7's
 * existing tracker traffic and point it at our self-hosted box:
 *
 *   1. HOST swap:  openreplay.canary7.com  ->  replay.malpasoft.com   (everywhere)
 *   2. KEY  swap:  in /ingest/v1/web/start body, C7's key -> ours
 *
 * IMPORTANT: OpenReplay uploads the actual session data (/ingest/v1/web/i) from a
 * Web Worker, which has its own JS global. Patching window.fetch/XHR only covers
 * the main thread (start, feature-flags). To catch the worker's uploads we also:
 *   - rewrite the host in Worker.postMessage payloads (where the ingest URL is
 *     handed to the worker), and
 *   - rewrite the host inside any Blob used to build the worker.
 *
 * Everything else C7 sends (userUUID, userID, trackerVersion, token, batches) is
 * passed through untouched.
 *
 * VERSION NOTE: C7 ships tracker v11.0.6; our backend is current. Session starts
 * fine; replay fidelity depends on backend/tracker compatibility — verify with a
 * real recorded session.
 */

(function () {
  'use strict';

  var OLD_HOST = 'openreplay.canary7.com';
  var NEW_HOST = 'replay.malpasoft.com';
  var C7_KEY   = 'iAlX3UIW9hXkdmw9uho1';   // Canary7's baked-in key (rejected by our server)
  var OUR_KEY  = 'XM93gZiNw5XkowtXrvvO';   // Malpa self-hosted project key
  var TAG      = '[Malpa OR Redirect]';

  function swapHost(s) {
    return (typeof s === 'string' && s.indexOf(OLD_HOST) !== -1)
      ? s.split(OLD_HOST).join(NEW_HOST)
      : s;
  }

  function rewriteUrl(url) {
    var out = swapHost(url);
    if (out !== url) console.log(TAG, 'url', url, '->', out);
    return out;
  }

  // Swap the project key inside the /start body (JSON string).
  function rewriteBody(url, body) {
    try {
      if (typeof body === 'string'
          && String(url).indexOf('/ingest/v1/web/start') !== -1
          && body.indexOf(C7_KEY) !== -1) {
        console.log(TAG, 'swapped projectKey in start body');
        return body.split(C7_KEY).join(OUR_KEY);
      }
    } catch (e) {}
    return body;
  }

  // Recursively swap the host in a postMessage payload (string / array / object).
  function deepSwap(obj) {
    try {
      if (typeof obj === 'string') return swapHost(obj);
      if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) obj[i] = deepSwap(obj[i]); return obj; }
      if (obj && typeof obj === 'object') {
        for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) obj[k] = deepSwap(obj[k]); }
      }
    } catch (e) {}
    return obj;
  }

  // --- MAIN THREAD: XMLHttpRequest ---
  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = rewriteUrl(url);
    this.__orUrl = arguments[1];
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try { if (typeof body === 'string') arguments[0] = rewriteBody(this.__orUrl, body); } catch (e) {}
    return _send.apply(this, arguments);
  };

  // --- MAIN THREAD: fetch ---
  if (window.fetch) {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === 'string') ? input : (input && input.url);
        var newUrl = rewriteUrl(url);
        if (init && typeof init.body === 'string') {
          init = Object.assign({}, init, { body: rewriteBody(newUrl, init.body) });
        }
        if (typeof input === 'string') input = newUrl;
        else if (input && input.url && newUrl !== input.url) input = new Request(newUrl, input);
      } catch (e) {}
      return _fetch.call(this, input, init);
    };
  }

  // --- MAIN THREAD: sendBeacon ---
  if (navigator.sendBeacon) {
    var _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { return _beacon(rewriteUrl(url), data); };
  }

  // --- WORKER: rewrite the ingest URL handed to the worker via postMessage ---
  if (window.Worker && Worker.prototype && Worker.prototype.postMessage) {
    var _post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, transfer) {
      try {
        var swapped = deepSwap(msg);
        console.log(TAG, 'worker postMessage scanned');
        return _post.call(this, swapped, transfer);
      } catch (e) { return _post.call(this, msg, transfer); }
    };
  }

  // --- WORKER: rewrite the host inside any Blob used to build the worker ---
  try {
    var NativeBlob = window.Blob;
    function PatchedBlob(parts, options) {
      try {
        if (Array.isArray(parts)) {
          for (var i = 0; i < parts.length; i++) {
            if (typeof parts[i] === 'string' && parts[i].indexOf(OLD_HOST) !== -1) {
              parts[i] = swapHost(parts[i]);
              console.log(TAG, 'rewrote host inside a Blob (worker code)');
            }
          }
        }
      } catch (e) {}
      return new NativeBlob(parts, options);
    }
    PatchedBlob.prototype = NativeBlob.prototype;
    window.Blob = PatchedBlob;
  } catch (e) {}

  console.log(TAG, 'v0.3.0 active — host', OLD_HOST, '=>', NEW_HOST, '| key swap on start | worker covered');
})();
