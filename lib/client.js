// dsh-effort-pilot — CLIENT half.
//
// Registers ONE entry in `conversation.input.right` (`conversation.composer.bar`'s
// "compact controls before the composer submit action" seat, scope `session` —
// the same seat `capability-panel` occupies) showing the reasoning level the
// scheduler actually asked the provider for.
//
// WHY A SLOT AND NOT AN INJECTED SCRIPT
// The previous design injected a plain <script> and positioned the chip by
// ANCHORING ON THE COMPOSER DOM. That broke twice, silently, and had to be
// re-diagnosed by shipping instrumented probes into the page. This file renders
// through the documented Slot API instead: the slot owner decides placement, so a
// layout change can no longer strand the chip — and slot names are a contract,
// not incidental markup.
//
// Bundle format: `window.__ModuleLoader__.load({ id, factory })` — the lazy-CJS
// table contract consumed by dsh-web-app. The factory requires only `react` (the
// host's shared client module table), so this file stays self-contained:
// no relative require, no JSX, no build step.
//
// Data comes from the host half's own same-origin route:
//   GET /dsh-effort/state.json
// the identical pattern `dsh-answer-reviewer` uses for its score feed. The host
// writes the file; this reads it. Nothing else is shared.

window.__ModuleLoader__.load({
  id: "dsh-effort-pilot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // —— react (defensive default interop) ——
    var reactModule = require("react");
    var react = reactModule && reactModule.default ? reactModule.default : reactModule;
    var createElement = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    /** The composer tool row, just before the submit action. */
    var SLOT = "conversation.input.right";
    var ENTRY_ID = "effort-pilot-level";
    // After the shipped entries. `capability-panel` sits at 1000; parking below
    // it keeps the level adjacent to the other compact controls.
    var ENTRY_ORDER = 900;

    var STATE_URL = "/dsh-effort/state.json";
    /**
     * Where the host counts "the client half is alive".
     *
     * This exists because a client bundle that fails to resolve, or a slot that is
     * not present, renders nothing and reports nothing — indistinguishable from a
     * host that never published. One beacon on mount makes those distinguishable.
     */
    var REPORT_URL = "/dsh-effort/report.json";
    var POLL_MS = 1000;
    /** Past this age the reading is not current, so nothing is shown. */
    var STALE_MS = 10 * 60 * 1000;

    /**
     * Announce that the chip mounted.
     *
     * Never throws: a beacon must not be able to break the composer. `at=chip`
     * records where it rendered, which is the fact the host cannot otherwise see.
     */
    function announce() {
      try {
        fetch(REPORT_URL + "?at=chip&t=" + Date.now(), { cache: "no-store" }).catch(function () {});
      } catch (err) { /* reporting must never affect the chip */ }
    }

    /** Theme tokens only, so light/dark follow automatically. */
    var COLORS = {
      low: "var(--dsw-alias-state-success-primary)",
      high: "var(--dsw-alias-state-warn-primary)",
      max: "var(--dsw-alias-state-error-primary)",
      idle: "var(--dsw-alias-state-idle-primary)",
      text: "var(--dsw-alias-label-secondary)",
    };

    function levelLabel(level) {
      if (level === "low") return "低";
      if (level === "high") return "高";
      if (level === "max") return "最大";
      if (level === "medium") return "中";
      if (level === "stripped") return "已剥离";
      return String(level || "?");
    }

    function levelColor(level) {
      if (level === "low" || level === "high" || level === "max") return COLORS[level];
      return COLORS.idle;
    }

    function tooltip(state) {
      var parts = ["思考档位：" + levelLabel(state.level)];
      if (state.difficulty !== undefined) parts.push("难度 " + state.difficulty);
      if (state.semanticScore !== undefined) parts.push("判定 " + state.semanticScore);
      if (state.reason) parts.push(String(state.reason));
      return parts.join(" · ");
    }

    /**
     * Poll the host's published decision.
     *
     * Returns undefined while nothing current is available, which the component
     * renders as `null` — the chip must never claim a level that is not the one
     * in force.
     */
    function useEffortState() {
      var pair = useState(null);
      var state = pair[0];
      var setState = pair[1];

      useEffect(function () {
        var cancelled = false;

        function tick() {
          try {
            fetch(STATE_URL, { cache: "no-store" })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                if (cancelled) return;
                if (!d || !d.ok || !d.level) {
                  setState(null);
                  return;
                }
                var ts = Number(d.ts) || 0;
                if (ts && Date.now() - ts > STALE_MS) {
                  setState(null);
                  return;
                }
                setState(d);
              })
              .catch(function () { /* host not answering: keep the last value */ });
          } catch (err) { /* never let the chip break the composer */ }
        }

        tick();
        // `setInterval` may be absent in a hostile page; without the guard a
        // missing timer would throw out of the effect and take the composer with
        // it. The first `tick()` above already ran, so the chip still works.
        var timer;
        try { timer = setInterval(tick, POLL_MS); } catch (err) { timer = undefined; }
        return function () {
          cancelled = true;
          try { if (timer !== undefined) clearInterval(timer); } catch (err) { /* nothing to clear */ }
        };
      }, []);

      return state;
    }

    /**
     * The chip: a small coloured dot plus the level word.
     *
     * Deliberately a TEXT LABEL, not a pill: the controls beside it have no
     * background and no border, so a filled pill reads as a foreign element.
     * Only the dot carries the colour, which keeps the row calm.
     */
    function EffortLevelChip() {
      var state = useEffortState();

      // Announce once per mount, BEFORE the null return below: the interesting
      // case is precisely "mounted but nothing to show yet", which the host must
      // be able to tell apart from "the client half never ran".
      useEffect(function () {
        announce();
      }, []);

      if (!state || !state.level) return null;

      var color = levelColor(state.level);
      return createElement(
        "span",
        {
          // Readable by a DOM smoke test and by anyone inspecting the composer.
          "data-effort-level": String(state.level),
          title: tooltip(state),
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "0 2px",
            fontSize: "12px",
            lineHeight: 1,
            whiteSpace: "nowrap",
            userSelect: "none",
            flex: "0 0 auto",
            fontFamily: "inherit",
            fontWeight: "inherit",
            color: COLORS.text,
          },
        },
        createElement("span", {
          "data-effort-dot": "",
          style: {
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            flex: "0 0 auto",
            background: color,
          },
        }),
        createElement("span", null, levelLabel(state.level)),
      );
    }

    /**
     * Plugin entry (client side).
     *
     * `slots` is a core client service, so it is requested OPTIONALLY through
     * `ctx.inject` rather than declared in `dsh.client.inject`. Declaring it would
     * leave this entry "pending (waiting for service)" on a host without it, which
     * the web boot audit reports as a failed plugin and the host renders as a
     * "Failed to load plugins" banner over the main page. Optional means: absent
     * service, nothing registered, nothing broken.
     */
    function apply(ctx) {
      ctx.inject(["slots"], function (scope) {
        scope.slots.inject(SLOT, function () {
          return scope.slots.register(
            { name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER },
            EffortLevelChip,
          );
        });
      });
    }

    exports.name = "dsh-effort-pilot";
    exports.apply = apply;
    return module.exports;
  },
});
