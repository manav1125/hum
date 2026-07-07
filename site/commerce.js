/**
 * Cue site — commerce wiring against the Cue HQ control plane.
 *
 * Loaded as a plain global script by the commerce pages (index, pricing,
 * redeem, welcome, signin, account). The pages themselves render through
 * support.js (the DC runtime); their per-page Component classes call into
 * `window.CueCommerce` for every real backend interaction, so all HTTP
 * details live in this one file.
 *
 * In production the site is SERVED BY HQ itself (hq/src/site.ts), so every
 * call is same-origin — no CORS, and the /account session cookie just
 * works. `window.CUE_HQ_BASE` can point at a remote HQ for local previews.
 *
 * Backend contract: hq/README.md § "Website integration contract".
 */
(function () {
  "use strict";

  var base = String(window.CUE_HQ_BASE || "").replace(/\/+$/, "");

  // The designed pages use short plan slugs (?plan=chief); HQ's canonical
  // tier ids are assistant | chief_of_staff | operator.
  var PLAN_ALIASES = {
    assistant: "assistant",
    chief: "chief_of_staff",
    chief_of_staff: "chief_of_staff",
    operator: "operator",
    founding: "chief_of_staff",
    founding_byo: "chief_of_staff",
  };

  // Fallback copy when GET /plans is unreachable (static preview hosting).
  var PLAN_FALLBACK = {
    assistant: { id: "assistant", name: "Assistant", priceUsd: 49, monthlyCredits: 4000 },
    chief_of_staff: { id: "chief_of_staff", name: "Chief of Staff", priceUsd: 99, monthlyCredits: 10000 },
    operator: { id: "operator", name: "Operator", priceUsd: 249, monthlyCredits: 30000 },
  };

  function apiCall(method, path, body) {
    var opts = {
      method: method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(base + path, opts).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (json) {
          return { status: res.status, ok: res.ok, body: json };
        });
    });
  }

  var plansPromise = null;

  window.CueCommerce = {
    /** Canonical plan id from any slug the site uses, or null. */
    normalizePlan: function (raw) {
      var key = String(raw || "").trim().toLowerCase();
      return PLAN_ALIASES[key] || null;
    },

    planFromQuery: function () {
      return this.normalizePlan(
        new URLSearchParams(location.search).get("plan"),
      );
    },

    sessionIdFromQuery: function () {
      var v = new URLSearchParams(location.search).get("session_id");
      return v ? v.trim() : null;
    },

    /** GET /plans (cached). Resolves to {plans:{<id>:spec}} with fallback. */
    fetchPlans: function () {
      if (!plansPromise) {
        plansPromise = apiCall("GET", "/plans")
          .then(function (res) {
            var byId = {};
            var list = (res.body && res.body.plans) || [];
            for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i];
            return Object.keys(byId).length
              ? { plans: byId, topups: res.body.topups || [] }
              : { plans: PLAN_FALLBACK, topups: [] };
          })
          .catch(function () {
            return { plans: PLAN_FALLBACK, topups: [] };
          });
      }
      return plansPromise;
    },

    planCopy: function (catalog, planId) {
      var p = (catalog && catalog.plans && catalog.plans[planId]) || PLAN_FALLBACK[planId];
      if (!p) return null;
      return {
        id: p.id,
        name: p.name,
        price: "$" + p.priceUsd + "/mo",
        credits: p.monthlyCredits.toLocaleString("en-US") + " credits",
      };
    },

    /** POST /waitlist. Name is required server-side — default sensibly. */
    joinWaitlist: function (params) {
      var email = String(params.email || "").trim();
      var name = String(params.name || "").trim() || email.split("@")[0];
      return apiCall("POST", "/waitlist", {
        email: email,
        name: name,
        plan: this.normalizePlan(params.plan) || undefined,
      });
    },

    /**
     * POST /redeem → typed outcome for the designed states:
     *   {kind:"checkout", url}          — go to Stripe
     *   {kind:"unavailable", reason}    — redeemed, checkout not configured
     *   {kind:"invalid"|"expired"}      — designed error states
     *   {kind:"error", message}         — anything else
     */
    redeem: function (params) {
      return apiCall("POST", "/redeem", {
        code: String(params.code || "").trim().toUpperCase(),
        email: String(params.email || "").trim(),
        name: String(params.name || "").trim(),
        plan: this.normalizePlan(params.plan) || undefined,
      }).then(function (res) {
        if (res.ok && res.body.ok) {
          return res.body.checkoutUrl
            ? { kind: "checkout", url: res.body.checkoutUrl }
            : { kind: "unavailable", reason: res.body.reason || "" };
        }
        var reason = (res.body && res.body.error) || "";
        if (res.status === 404 || reason === "invite_unknown") {
          return { kind: "invalid" };
        }
        if (
          res.status === 410 ||
          reason === "invite_expired" ||
          reason === "invite_exhausted"
        ) {
          return { kind: "expired" };
        }
        return { kind: "error", message: reason || "Something went wrong." };
      });
    },

    /** GET /welcome/status → {state, magicLink?, firstName?, email?}. */
    welcomeStatus: function (sessionId) {
      return apiCall(
        "GET",
        "/welcome/status?session_id=" + encodeURIComponent(sessionId),
      ).then(function (res) {
        return res.body && res.body.state ? res.body : { state: "unknown" };
      });
    },

    /** POST /signin — always resolves (the page shows "sent" regardless). */
    signin: function (email) {
      return apiCall("POST", "/signin", { email: String(email || "").trim() });
    },

    /** GET /account/summary → {status, body} (401 ⇒ caller redirects). */
    accountSummary: function () {
      return apiCall("GET", "/account/summary");
    },

    /** POST /testflight — records interest, idempotent per email. */
    testflight: function (email) {
      return apiCall("POST", "/testflight", { email: String(email || "").trim() });
    },

    /** POST /account/topup {pack} → {kind:"checkout"|"unavailable"|"unauthorized"|"error"}. */
    topup: function (pack) {
      return apiCall("POST", "/account/topup", { pack: pack }).then(function (res) {
        if (res.status === 401) return { kind: "unauthorized" };
        if (res.ok && res.body.ok) {
          return res.body.checkoutUrl
            ? { kind: "checkout", url: res.body.checkoutUrl }
            : { kind: "unavailable", reason: res.body.reason || "" };
        }
        return {
          kind: "error",
          message: (res.body && res.body.error) || "Something went wrong.",
        };
      });
    },

    /** href for the Stripe billing portal (server-side 302). */
    portalHref: (base || "") + "/account/portal",
  };

  // Deep links like /#waitlist: the DC runtime (support.js) re-renders the
  // page content after load, which defeats the browser's native anchor
  // scroll. Re-run the scroll once the target element actually exists.
  function scrollToHash() {
    var id = (location.hash || "").slice(1);
    if (!id) return;
    var tries = 0;
    (function attempt() {
      var el = document.getElementById(id);
      if (el) { el.scrollIntoView(); return; }
      if (++tries < 40) setTimeout(attempt, 100);
    })();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scrollToHash);
  } else {
    scrollToHash();
  }
  window.addEventListener("load", function () { setTimeout(scrollToHash, 50); });
})();
