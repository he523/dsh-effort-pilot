// dsh-effort-pilot — CLIENT half.
//
// Registers TWO entries:
//
//   1. `conversation.input.right` — the level chip. A small coloured dot plus the
//      level word, showing the effort level the scheduler actually asked the
//      provider for. This is the only way to see what `Auto` chose, because the
//      model selector just says "auto".
//
//   2. `settings.section` — the configuration card. Thresholds, sampling, and the
//      behaviour switches, plus a read-only view of what the judge has actually
//      been returning. Without it every one of those values is only reachable by
//      hand-editing the profile's `cordis.patch.yml` and restarting.
//
// WHY SLOTS AND NOT AN INJECTED SCRIPT
// The chip was previously a plain <script> positioned by SEARCHING THE COMPOSER
// DOM. That broke twice, silently, and had to be re-diagnosed by shipping
// instrumented probes into the page. The Slot API removes that whole class of
// failure: the slot owner decides placement.
//
// Bundle format: `window.__ModuleLoader__.load({ id, factory })` — the lazy-CJS
// table contract consumed by dsh-web-app. The factory requires only `react` (the
// host's shared client module table), so this file stays self-contained:
// no relative require, no JSX, no build step.
//
// Data comes from the host half's own same-origin routes:
//   GET  /dsh-effort/state.json    the last decision (the chip reads this)
//   GET  /dsh-effort/config.json   live values, declared baseline, observations
//   POST /dsh-effort/config.json   persist a change from the card
//   GET  /dsh-effort/report.json   "the client half is alive" beacon

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
    var CHIP_SLOT = "conversation.input.right";
    var CHIP_ID = "effort-pilot-level";
    // After the shipped entries. `capability-panel` sits at 1000; parking below
    // it keeps the level adjacent to the other compact controls.
    var CHIP_ORDER = 900;

    /** The settings panel section. */
    var SECTION_SLOT = "settings.section";
    var SECTION_ID = "effort-pilot";
    // After the shipped sections; `capability-panel` sits at 25.
    var SECTION_ORDER = 40;

    var STATE_URL = "/dsh-effort/state.json";
    var CONFIG_URL = "/dsh-effort/config.json";
    var REPORT_URL = "/dsh-effort/report.json";
    var POLL_MS = 1000;
    /** Past this age the reading is not current, so nothing is shown. */
    var STALE_MS = 10 * 60 * 1000;

    /** Theme tokens only, so light/dark follow automatically. */
    var COLORS = {
      low: "var(--dsw-alias-state-success-primary)",
      high: "var(--dsw-alias-state-warn-primary)",
      max: "var(--dsw-alias-state-error-primary)",
      idle: "var(--dsw-alias-state-idle-primary)",
      text: "var(--dsw-alias-label-secondary)",
      textStrong: "var(--dsw-alias-label-primary)",
      border: "var(--dsw-alias-border-l1)",
      surface: "var(--dsw-alias-bg-layer-2)",
      accent: "var(--dsw-alias-brand-primary)",
      base: "var(--dsw-alias-bg-base)",
    };

    /**
     * Announce that the client half mounted.
     *
     * Never throws: a beacon must not be able to break the UI. The host cannot
     * otherwise tell "the bundle never loaded" from "loaded but the slot was
     * absent" — both look exactly like silence.
     */
    function announce(at) {
      try {
        fetch(REPORT_URL + "?at=" + encodeURIComponent(at || "chip") + "&t=" + Date.now(), { cache: "no-store" })
          .catch(function () {});
      } catch (err) { /* reporting must never affect the UI */ }
    }

    function levelLabel(level) {
      // `String()` on an object with a non-callable `toString` raises, and this
      // runs during render — a throw here would take out the composer slot. The
      // host always publishes a string, so this only matters for a hand-edited
      // state file, but a render path must not be able to throw on bad input.
      var safe = typeof level === "string" ? level : "";
      if (safe === "low") return "低";
      if (safe === "high") return "高";
      if (safe === "max") return "最大";
      if (safe === "medium") return "中";
      if (safe === "stripped") return "已剥离";
      return safe || "?";
    }

    function levelColor(level) {
      if (level === "low" || level === "high" || level === "max") return COLORS[level];
      return COLORS.idle;
    }

    function levelTooltip(state) {
      var parts = ["思考档位：" + levelLabel(state.level)];
      if (state.difficulty !== undefined) parts.push("难度 " + String(state.difficulty));
      if (state.semanticScore !== undefined) parts.push("判定 " + String(state.semanticScore));
      if (state.reason) parts.push(String(state.reason));
      return parts.join(" · ");
    }

    /* ================================================================ *
     * The chip
     * ================================================================ */

    /**
     * Poll the host's published decision.
     *
     * Returns null while nothing current is available, which the component
     * renders as nothing — the chip must never claim a level that is not in force.
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
                if (!d || !d.ok || !d.level) { setState(null); return; }
                var ts = Number(d.ts) || 0;
                if (ts && Date.now() - ts > STALE_MS) { setState(null); return; }
                setState(d);
              })
              .catch(function () { /* host not answering: keep the last value */ });
          } catch (err) { /* never let the chip break the composer */ }
        }

        tick();
        // `setInterval` may be absent in a hostile page; without the guard a
        // missing timer would throw out of the effect and take the composer with
        // it. The first `tick()` already ran, so the chip still works.
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
      useEffect(function () { announce("chip"); }, []);

      // Only a STRING is renderable. Anything else (a hand-edited state file, a
      // transport that re-encoded the payload) means "nothing to show" rather than
      // a throw during render.
      if (!state || typeof state.level !== "string" || state.level === "") return null;

      return createElement(
        "span",
        {
          // Readable by a DOM smoke test and by anyone inspecting the composer.
          "data-effort-level": state.level,
          title: levelTooltip(state),
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
            background: levelColor(state.level),
          },
        }),
        createElement("span", null, levelLabel(state.level)),
      );
    }

    /* ================================================================ *
     * The settings card
     * ================================================================ */

    /**
     * Field definitions for the card.
     *
     * `path` addresses the host's config; `nested` chooses `semantic.*`. Kept as
     * data so the form and the payload cannot drift apart.
     */
    var FIELDS = [
      { path: "lowMax", label: "降档阈值 lowMax", hint: "判定低于此值就走 low。实测判定集中在 0/3/5/6，所以 2 与 3 之间改一格，行为就明显变化。", type: "number", min: 0, max: 10 },
      { path: "highMin", label: "升档阈值 highMin", hint: "判定高于此值才走 max。调小会更容易触发最贵档位。", type: "number", min: 0, max: 10 },
      { path: "mode", label: "模式 mode", hint: "local = 只用本地信号（零出站）；hybrid = 额外抽样问语义判定器。", type: "enum", values: ["hybrid", "local"] },
      { path: "resampleDecisions", label: "重采样间隔 resampleDecisions", hint: "每多少次决策至少问一次判定器。调大 = 更省钱、更迟钝。", nested: "semantic", type: "number", min: 1, max: 1000 },
      { path: "timeoutMs", label: "判定超时 timeoutMs", hint: "每次尝试的上限（失败会重试一次，所以最坏约为两倍）。这是请求路径上的真实延迟。", nested: "semantic", type: "number", min: 250, max: 30000 },
      { path: "maxCallsPerSession", label: "每会话上限 maxCallsPerSession", hint: "0 = 不限制。", nested: "semantic", type: "number", min: 0, max: 100000 },
      { path: "allowUpgrade", label: "允许升档 allowUpgrade", hint: "关掉则最高只到 high，max 永远不可达。", type: "boolean" },
      { path: "allowDowngrade", label: "允许降档 allowDowngrade", hint: "关掉则不降档，最低维持 high。", type: "boolean" },
      { path: "respectManual", label: "尊重手动选档 respectManual", hint: "关掉则插件会覆盖你在选择器里手选的档位。", type: "boolean" },
      { path: "advertiseAuto", label: "在选择器里提供 Auto", hint: "关掉后模型选择器不再出现 Auto 项。", type: "boolean" },
      // `chip` is intentionally NOT offered here: it gates route registration, so
      // switching it off from this card would remove the card's own data route on
      // the next start and leave no way back through the UI. Set it in
      // cordis.patch.yml instead.
      { path: "journal", label: "写决策日志", hint: "关掉则无法事后复盘调度行为。立即生效。", type: "boolean" },
      { path: "enabled", label: "启用调度", hint: "总开关。关掉后插件不改写任何请求。", type: "boolean" },
    ];

    function readPath(source, field) {
      if (!source) return undefined;
      if (field.nested) return source[field.nested] ? source[field.nested][field.path] : undefined;
      return source[field.path];
    }

    function writePath(target, field, value) {
      var next = Object.assign({}, target);
      if (field.nested) {
        next[field.nested] = Object.assign({}, next[field.nested]);
        next[field.nested][field.path] = value;
      } else {
        next[field.path] = value;
      }
      return next;
    }

    /**
     * Reduce the live config to just the keys this card owns.
     *
     * The host's `effective` object is the WHOLE resolved config, which also
     * contains a group the card does not manage (the scoring `weights`). Posting it
     * verbatim made the host report every one of those keys as rejected, so a
     * perfectly good save produced a list of "rejected keys" — a false alarm that
     * would train the user to ignore the one warning that actually matters.
     *
     * The allowed set comes from the host's own published whitelist rather than
     * from this file's `FIELDS`, so the two cannot drift: if the host stops
     * accepting a key, the card stops sending it.
     */
    function pickEditable(current, data) {
      var out = {};
      if (!current) return out;
      var top = (data && data.editable) || {};
      var nested = (data && data.editableNested) || {};
      var key;

      for (key in top) {
        if (Object.prototype.hasOwnProperty.call(top, key) && current[key] !== undefined) {
          out[key] = current[key];
        }
      }
      for (var group in nested) {
        if (!Object.prototype.hasOwnProperty.call(nested, group)) continue;
        var source = current[group];
        if (!source) continue;
        var picked = {};
        var any = false;
        for (key in nested[group]) {
          if (!Object.prototype.hasOwnProperty.call(nested[group], key)) continue;
          if (source[key] !== undefined) {
            picked[key] = source[key];
            any = true;
          }
        }
        if (any) out[group] = picked;
      }
      return out;
    }

    /** Fetch the card's data, with an explicit error state rather than silence. */
    function useConfiguration() {
      var pair = useState({ status: "loading", data: null, error: null });
      var snapshot = pair[0];
      var setSnapshot = pair[1];
      var noncePair = useState(0);
      var nonce = noncePair[0];
      var setNonce = noncePair[1];

      useEffect(function () {
        var cancelled = false;
        fetch(CONFIG_URL, { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (cancelled) return;
            if (!d || !d.ok) {
              setSnapshot({ status: "error", data: null, error: "host returned an unusable payload" });
              return;
            }
            setSnapshot({ status: "ready", data: d, error: null });
          })
          .catch(function (err) {
            if (cancelled) return;
            // A dead route must say so: a card rendering empty fields looks like
            // "everything is unset" rather than "the host is not answering".
            setSnapshot({ status: "error", data: null, error: String((err && err.message) || err) });
          });
        return function () { cancelled = true; };
      }, [nonce]);

      return { snapshot: snapshot, reload: function () { setNonce(function (n) { return n + 1; }); } };
    }

    var inputStyle = {
      width: "84px",
      padding: "4px 7px",
      fontSize: "13px",
      color: COLORS.textStrong,
      background: COLORS.surface,
      border: "1px solid " + COLORS.border,
      borderRadius: "6px",
      fontFamily: "inherit",
    };

    function button(label, primary, onClick, disabled) {
      return createElement(
        "button",
        {
          type: "button",
          onClick: disabled === true ? undefined : onClick,
          disabled: disabled === true,
          style: {
            padding: "5px 12px",
            fontSize: "12px",
            borderRadius: "6px",
            cursor: disabled === true ? "not-allowed" : "pointer",
            opacity: disabled === true ? 0.5 : 1,
            fontFamily: "inherit",
            color: primary ? COLORS.base : COLORS.textStrong,
            background: primary ? COLORS.accent : COLORS.surface,
            border: primary ? "1px solid transparent" : "1px solid " + COLORS.border,
          },
        },
        label,
      );
    }

    function row(label, hint, control) {
      return createElement(
        "div",
        {
          key: label,
          style: {
            display: "flex",
            gap: "12px",
            alignItems: "flex-start",
            padding: "8px 0",
            borderTop: "1px solid " + COLORS.border,
          },
        },
        createElement(
          "div",
          { style: { flex: "1 1 auto", minWidth: 0 } },
          createElement("div", { style: { fontSize: "13px", color: COLORS.textStrong } }, label),
          hint
            ? createElement("div", {
              style: { fontSize: "11px", color: COLORS.text, marginTop: "2px", lineHeight: 1.45 },
            }, hint)
            : null,
        ),
        createElement("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center" } }, control),
      );
    }

    function EffortPilotSettings() {
      var config = useConfiguration();
      var draftPair = useState(null);
      var draft = draftPair[0];
      var setDraft = draftPair[1];
      var statusPair = useState(null);
      var status = statusPair[0];
      var setStatus = statusPair[1];

      useEffect(function () { announce("settings"); }, []);

      var data = config.snapshot.data;
      // The form starts from the live values and only diverges once edited.
      var current = draft || (data ? data.effective : null);
      var overrides = data ? (data.overrides || {}) : {};
      var overrideCount = Object.keys(overrides).length;
      var hasOverrides = overrideCount > 0;

      function set(field, value) {
        setDraft(writePath(current || {}, field, value));
        setStatus(null);
      }

      function post(payload, okMessage) {
        setStatus({ kind: "busy", text: "保存中…" });
        fetch(CONFIG_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.ok) {
              setStatus({ kind: "error", text: "保存失败：" + String((d && d.error) || "未知原因") });
              return;
            }
            var rejected = d.rejected || [];
            setStatus({
              kind: rejected.length > 0 ? "warn" : "ok",
              text: rejected.length > 0
                // Report rejected keys rather than quietly dropping them: a typo
                // that saves "successfully" but changes nothing is the worst case.
                // `ignored` is deliberately NOT shown — those are keys this card
                // does not manage, so warning about them would be noise.
                ? okMessage + "，但被拒绝的键：" + rejected.join(", ")
                : okMessage,
            });
            setDraft(null);
            config.reload();
          })
          .catch(function (err) {
            setStatus({ kind: "error", text: "保存失败：" + String((err && err.message) || err) });
          });
      }

      if (config.snapshot.status === "loading") {
        return createElement(
          "div",
          { style: { fontSize: "13px", color: COLORS.text, padding: "8px 0" } },
          "读取配置中…",
        );
      }
      if (config.snapshot.status === "error") {
        return createElement(
          "div",
          { style: { fontSize: "13px", color: COLORS.max, padding: "8px 0" } },
          createElement("div", null, "读不到插件配置。"),
          createElement("div", { style: { fontSize: "11px", color: COLORS.text, marginTop: "4px", lineHeight: 1.5 } },
            String(config.snapshot.error)
            + " —— 宿主路由 /dsh-effort/config.json 可能未注册（插件未激活，或 chip 被关闭）。"),
        );
      }

      var observations = data.observations || {};
      var verdicts = observations.verdicts || {};
      var histogram = verdicts.histogram || {};
      var keys = Object.keys(histogram).map(Number).sort(function (a, b) { return a - b; });
      var peak = keys.reduce(function (m, k) { return Math.max(m, histogram[k]); }, 1);
      var lowMax = current && current.lowMax !== undefined ? current.lowMax : 2;
      var highMin = current && current.highMin !== undefined ? current.highMin : 6;

      return createElement(
        "div",
        { style: { fontSize: "13px" } },

        createElement(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", paddingBottom: "8px" } },
          button("保存", true, function () { post({ values: pickEditable(current, data) }, "已保存"); }),
          button("恢复为配置文件的声明值", false, function () { post({ reset: true }, "已清除覆盖"); }, !hasOverrides),
          status
            ? createElement("span", {
              style: {
                fontSize: "12px",
                color: status.kind === "error"
                  ? COLORS.max
                  : (status.kind === "warn" ? COLORS.high : COLORS.text),
              },
              title: status.text,
            }, status.text)
            : null,
        ),

        hasOverrides
          ? createElement("div", { style: { fontSize: "11px", color: COLORS.text, paddingBottom: "4px", lineHeight: 1.5 } },
            "当前有 " + overrideCount + " 项覆盖正在生效（优先级高于 cordis.patch.yml）。"
            + "上方的「恢复」会删除全部覆盖。")
          : null,

        createElement(
          "div",
          {
            style: {
              border: "1px solid " + COLORS.border,
              borderRadius: "8px",
              padding: "10px 12px",
              margin: "4px 0 12px",
              background: COLORS.surface,
            },
          },
          createElement("div", { style: { fontSize: "12px", color: COLORS.textStrong, marginBottom: "6px" } }, "当前状态（只读）"),
          createElement("div", { style: { fontSize: "12px", color: COLORS.text, lineHeight: 1.6 } },
            observations.lastDecision
              ? "最近决策：" + levelLabel(observations.lastDecision.level)
                + (observations.lastDecision.difficulty !== undefined ? " · 难度 " + observations.lastDecision.difficulty : "")
                + (observations.lastDecision.semanticScore !== undefined ? " · 判定 " + observations.lastDecision.semanticScore : "")
                + (observations.lastDecision.reason ? " · " + observations.lastDecision.reason : "")
              : "还没有决策记录。"),
          createElement("div", { style: { fontSize: "12px", color: COLORS.text, marginTop: "6px" } },
            "判定值分布（最近 " + (verdicts.samples || 0) + " 次"
            + (verdicts.min !== undefined ? "，范围 " + verdicts.min + "–" + verdicts.max : "") + "）："),
          keys.length === 0
            ? createElement("div", { style: { fontSize: "12px", color: COLORS.text } }, "（还没有判定样本）")
            : createElement("div", { style: { marginTop: "4px" } },
              keys.map(function (k) {
                var count = histogram[k];
                var width = Math.max(2, Math.round((count / peak) * 100));
                // Shade each bar by the band the CURRENT thresholds put it in, so
                // moving a threshold visibly re-colours the distribution.
                var band = k < lowMax ? "low" : (k > highMin ? "max" : "high");
                return createElement(
                  "div",
                  { key: "v" + k, style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" } },
                  createElement("span", { style: { width: "18px", textAlign: "right", fontSize: "11px", color: COLORS.text } }, String(k)),
                  createElement("span", {
                    style: {
                      height: "8px",
                      width: width + "%",
                      minWidth: "2px",
                      borderRadius: "2px",
                      background: levelColor(band),
                    },
                  }),
                  createElement("span", { style: { fontSize: "11px", color: COLORS.text } }, "×" + count + " → " + levelLabel(band)),
                );
              })),
        ),

        FIELDS.map(function (field) {
          var value = readPath(current || {}, field);
          var overridden = readPath(overrides, field) !== undefined;
          var control;
          if (field.type === "boolean") {
            control = createElement("input", {
              type: "checkbox",
              checked: value === true,
              onChange: function (e) { set(field, e.target.checked); },
              style: { width: "16px", height: "16px", cursor: "pointer" },
            });
          } else if (field.type === "enum") {
            control = createElement(
              "select",
              {
                value: String(value),
                onChange: function (e) { set(field, e.target.value); },
                style: Object.assign({}, inputStyle, { width: "110px" }),
              },
              field.values.map(function (v) { return createElement("option", { key: v, value: v }, v); }),
            );
          } else {
            control = createElement("input", {
              type: "number",
              min: field.min,
              max: field.max,
              value: value === undefined ? "" : String(value),
              onChange: function (e) {
                var raw = e.target.value;
                set(field, raw === "" ? undefined : Number(raw));
              },
              style: inputStyle,
            });
          }
          return row(field.label + (overridden ? "（已覆盖）" : ""), field.hint, control);
        }),

        createElement("div", { style: { fontSize: "11px", color: COLORS.text, marginTop: "10px", lineHeight: 1.5 } },
          "改动立即生效，不需要重启：宿主每次决策都会重新读取配置。"
          + "「恢复」只删除本卡片写入的覆盖，cordis.patch.yml 里声明的值不受影响。"),
      );
    }

    /* ================================================================ *
     * Plugin entry (client side)
     * ================================================================ */

    /**
     * `slots` is a core client service, so it is requested OPTIONALLY through
     * `ctx.inject` rather than declared in `dsh.client.inject`. Declaring it would
     * leave this entry "pending (waiting for service)" on a host without it, which
     * the web boot audit reports as a failed plugin and the host renders as a
     * "Failed to load plugins" banner over the main page. Optional means: absent
     * service, nothing registered, nothing broken.
     *
     * Each surface is registered independently inside its own try/catch: a host
     * whose settings panel has no `settings.section` seat must still get the chip,
     * and a host without a composer must still get the card.
     *
     * The catch REPORTS rather than swallowing. Isolation is right — one missing
     * seat must not remove the other surface — but a genuine failure (a bad
     * `register` option, a rejected component) would otherwise vanish with no trace
     * anywhere, and "the surface silently did not appear" is the single hardest
     * class of bug to diagnose in this plugin. It is also the beacon the host uses
     * to tell "never loaded" from "loaded but absent".
     */
    function registerSurface(scope, slot, config, component) {
      try {
        scope.slots.inject(slot, function () {
          return scope.slots.register(config, component);
        });
        return true;
      } catch (err) {
        var detail = (err && err.message) ? err.message : String(err);
        announce("error:" + slot + ":" + detail.slice(0, 120));
        try {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[dsh-effort-pilot] could not register " + slot + ": " + detail);
          }
        } catch (ignored) { /* no console: the beacon already went out */ }
        return false;
      }
    }

    function apply(ctx) {
      ctx.inject(["slots"], function (scope) {
        registerSurface(
          scope,
          CHIP_SLOT,
          { name: CHIP_SLOT, id: CHIP_ID, order: CHIP_ORDER },
          EffortLevelChip,
        );
        registerSurface(
          scope,
          SECTION_SLOT,
          {
            name: SECTION_SLOT,
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: function () { return "档位调度"; },
          },
          EffortPilotSettings,
        );
      });
    }

    exports.name = "dsh-effort-pilot";
    exports.apply = apply;
    return module.exports;
  },
});
