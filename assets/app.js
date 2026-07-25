/* Renders a published snapshot. Never calls the checked services itself — a
 * page that did would go blank during the outages it exists to describe.
 *
 * Staleness is re-derived against the reader's clock, so a snapshot left behind
 * by a dead runner is shown as unknown rather than as its last claim.
 */
(function () {
  "use strict";

  var CONTRACT = {
    staleAfterMinutes: 45,
    historyWindowDays: 90,
    checkIntervalMinutes: 15,
  };

  var DAILY_LABEL = {
    unknown: "No data",
    operational: "Operational",
    degraded: "Degraded",
    down: "Down",
  };

  var OVERALL_LABEL = {
    operational: "All Systems Operational",
    "partial-outage": "Partial outage",
    "major-outage": "Major outage",
    unknown: "Status unknown",
  };

  /* Icon geometry matching the product's icon set. */
  var ICONS = {
    "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    "circle-alert": '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    "circle-x": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    "circle-help": '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  };

  var STATE_ICON = {
    operational: "circle-check",
    degraded: "circle-alert",
    down: "circle-x",
    unknown: "circle-help",
  };

  var OVERALL_ICON = {
    operational: "circle-check",
    "partial-outage": "circle-alert",
    "major-outage": "circle-x",
    unknown: "circle-help",
  };

  function icon(name) {
    return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || "") + "</svg>";
  }

  function el(root, name) { return root.querySelector("[data-" + name + "]"); }

  function minutesSince(iso, now) {
    var t = Date.parse(iso);
    if (isNaN(t)) return Infinity;
    return (now - t) / 60000;
  }

  function isStale(snapshot, now) {
    return minutesSince(snapshot.lastCheckedAt, now) > CONTRACT.staleAfterMinutes;
  }

  /* Days with no data are excluded: counting them either way would invent or
     hide outages. */
  function uptimePct(days) {
    var recorded = 0, successful = 0;
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      if (!d || d.state === "unknown") continue;
      recorded += d.recordedProbes || 0;
      successful += d.successfulProbes || 0;
    }
    if (recorded === 0) return null;
    return (successful / recorded) * 100;
  }

  function fmtPct(pct) {
    if (pct === null) return "no data yet";
    return pct.toFixed(2).replace(/\.00$/, "") + "% uptime";
  }

  function fmtWhen(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "never";
    var d = new Date(t);
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return months[d.getUTCMonth()] + " " + d.getUTCDate() + ", " +
      two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + " UTC";
  }

  /* Pad to exactly historyWindowDays so the bar is always the same width.
     Missing days render unknown — what a young page honestly shows, rather than
     a shorter bar that reads as solid history. */
  function padDays(days) {
    var out = (days || []).slice(-CONTRACT.historyWindowDays);
    while (out.length < CONTRACT.historyWindowDays) {
      out.unshift({ state: "unknown", recordedProbes: 0, successfulProbes: 0 });
    }
    return out;
  }

  function paintService(service, stale) {
    var article = document.createElement("article");
    article.className = "service";
    var state = stale ? "unknown" : (service.state || "unknown");
    var days = padDays(service.days);
    var pct = uptimePct(days);

    var top = document.createElement("div");
    top.className = "service-top";
    var name = document.createElement("div");
    name.className = "service-name";
    name.textContent = service.label;
    var pill = document.createElement("span");
    pill.className = "pill " + state;
    pill.innerHTML = icon(STATE_ICON[state] || "circle-help") +
      "<span>" + (DAILY_LABEL[state] || "No data") + "</span>";
    top.appendChild(name);
    top.appendChild(pill);

    var sub = document.createElement("p");
    sub.className = "service-sub";
    sub.textContent = service.sublabel || "";

    var bar = document.createElement("div");
    bar.className = "bar";
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", service.label + ": " + (DAILY_LABEL[state] || "No data") +
      ", " + fmtPct(pct) + " over the last " + CONTRACT.historyWindowDays + " days.");
    for (var i = 0; i < days.length; i++) {
      var span = document.createElement("span");
      span.className = "day " + (days[i].state || "unknown");
      span.title = days[i].date
        ? days[i].date + " — " + (DAILY_LABEL[days[i].state] || "No data")
        : "";
      bar.appendChild(span);
    }

    var meta = document.createElement("div");
    meta.className = "bar-meta";
    var a = document.createElement("span"); a.textContent = CONTRACT.historyWindowDays + " days ago";
    var b = document.createElement("span"); b.className = "pct"; b.textContent = fmtPct(pct);
    var c = document.createElement("span"); c.textContent = "Today";
    meta.appendChild(a); meta.appendChild(b); meta.appendChild(c);

    article.appendChild(top);
    if (service.sublabel) article.appendChild(sub);
    article.appendChild(bar);
    article.appendChild(meta);
    return article;
  }

  function paintIncidents(root, incidents, services) {
    var host = el(root, "incidents");
    host.innerHTML = "";

    if (!incidents || incidents.length === 0) {
      var none = document.createElement("div");
      none.className = "empty-incidents";
      none.innerHTML = icon("circle-check") +
        "<span>No incidents reported in the last " + CONTRACT.historyWindowDays + " days.</span>";
      host.appendChild(none);
      return;
    }

    var labelOf = {};
    (services || []).forEach(function (s) { labelOf[s.id] = s.label; });

    incidents.forEach(function (inc) {
      var art = document.createElement("article");
      art.className = "incident";

      var head = document.createElement("div");
      head.className = "incident-head";
      var h = document.createElement("h3");
      h.textContent = inc.title;
      head.appendChild(h);
      var badge = document.createElement("span");
      var resolved = inc.status === "resolved";
      badge.className = "pill " + (resolved ? "" : "down");
      badge.innerHTML = icon(resolved ? "circle-check" : "circle-alert") +
        "<span>" + (resolved ? "Resolved" : "Ongoing") + "</span>";
      head.appendChild(badge);
      art.appendChild(head);

      if (inc.affects && inc.affects.length) {
        var aff = document.createElement("p");
        aff.className = "affected";
        aff.textContent = "Affects: " + inc.affects.map(function (id) {
          return labelOf[id] || id;
        }).join(", ");
        art.appendChild(aff);
      }

      /* Newest update first — during an incident the latest line is the one
         people came for. */
      (inc.updates || []).forEach(function (u) {
        var up = document.createElement("div");
        up.className = "update";
        up.setAttribute("data-status", String(u.status || "").toLowerCase());
        var st = document.createElement("div");
        st.className = "status";
        st.textContent = u.status;
        var body = document.createElement("p");
        body.className = "body";
        body.textContent = u.body;
        var when = document.createElement("div");
        when.className = "when";
        when.textContent = fmtWhen(u.at);
        up.appendChild(st); up.appendChild(body); up.appendChild(when);
        art.appendChild(up);
      });

      host.appendChild(art);
    });
  }

  function render(root, snapshot, now) {
    var stale = isStale(snapshot, now);
    var overall = stale ? "unknown" : (snapshot.overall || "unknown");

    var banner = el(root, "banner");
    banner.setAttribute("data-state", overall);
    banner.innerHTML = icon(OVERALL_ICON[overall] || "circle-help") +
      "<span>" + (OVERALL_LABEL[overall] || OVERALL_LABEL.unknown) + "</span>";

    var services = el(root, "services");
    services.innerHTML = "";
    (snapshot.services || []).forEach(function (s) {
      services.appendChild(paintService(s, stale));
    });

    paintIncidents(root, snapshot.incidents, snapshot.services);

    var checkedEl = el(root, "checked");
    if (checkedEl) {
      checkedEl.innerHTML = icon("clock") + "<span>" +
        (snapshot.lastCheckedAt ? fmtWhen(snapshot.lastCheckedAt) : "no checks yet") + "</span>";
    }

    var fresh = el(root, "freshness");
    fresh.className = "freshness" + (stale ? " stale" : "");
    var text = "Last checked " + fmtWhen(snapshot.lastCheckedAt);
    if (stale) {
      text += " — more than " + CONTRACT.staleAfterMinutes + " minutes ago, so this page " +
        "cannot vouch for the readings above. They are shown as unknown rather than assumed good.";
    }
    text += " · Checks every " + CONTRACT.checkIntervalMinutes +
      " minutes · Hosted independently of Navipaw.com";
    fresh.innerHTML = icon(stale ? "circle-alert" : "clock") + "<span>" + text + "</span>";
  }

  function fail(root, message) {
    var banner = el(root, "banner");
    banner.setAttribute("data-state", "unknown");
    banner.innerHTML = icon("circle-help") + "<span>" + OVERALL_LABEL.unknown + "</span>";
    var fresh = el(root, "freshness");
    fresh.className = "freshness stale";
    fresh.innerHTML = icon("circle-alert") + "<span>" + message + "</span>";
  }

  function boot(root, url) {
    fetch(url, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (snapshot) { render(root, snapshot, Date.now()); })
      .catch(function (e) {
        fail(root, "Could not load status data (" + e.message + "). This page cannot " +
             "report right now — which is not the same as the service being down.");
      });
  }

  window.NaviPawStatus = {
    render: render, boot: boot, fail: fail, icon: icon,
    isStale: isStale, uptimePct: uptimePct, padDays: padDays,
  };
})();
