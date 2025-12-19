import React, { useEffect, useMemo, useRef, useState } from "react";

// Puck Herding Board (endless)
// - Pucks wander with different personalities
// - Your stick nudges them
// - Goal is to keep all pucks in the green zone, forever
// - Negative zones flash red when a puck enters them

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const randBetween = (a, b) => a + Math.random() * (b - a);
const length = (x, y) => Math.hypot(x, y);
const normalize = (x, y) => {
  const m = Math.hypot(x, y) || 1;
  return { x: x / m, y: y / m };
};
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

const DEFAULTS = {
  puckCount: 8,
  puckRadius: 16,
  boardW: 880,
  boardH: 460,
  targetZoneW: 140,

  // Movement
  maxSpeed: 140, // px/sec
  damping: 0.992,
  wanderStrength: 18, // accel px/sec^2
  jitterStrength: 34,
  jitterChancePerSec: 0.42,

  // Goal-zone leak (harder to keep them in)
  goalLeakStrength: 26,

  // Stick
  stickRadius: 22,
  stickPushStrength: 520,
  stickFriction: 0.92,

  // Collisions
  wallBounce: 0.92,
  puckRestitution: 0.9,

  // Alerts
  alertFlashMs: 450,
};

function makePucks(cfg) {
  const padding = 28;
  const pucks = [];
  for (let i = 0; i < cfg.puckCount; i++) {
    pucks.push({
      id: `p${i}`,
      x: randBetween(padding, cfg.boardW - cfg.targetZoneW - padding * 1.2),
      y: randBetween(padding, cfg.boardH - padding),
      vx: randBetween(-25, 25),
      vy: randBetween(-25, 25),

      wx: randBetween(-1, 1),
      wy: randBetween(-1, 1),

      // Personality
      wanderMult: randBetween(0.6, 1.6),
      jitterMult: randBetween(0.6, 1.4),
      speedMult: randBetween(0.7, 1.3),
      stubbornness: randBetween(0.8, 1.3),
      leakMult: randBetween(0.7, 1.4),

      hue: Math.round(randBetween(10, 330)),
    });
  }
  return pucks;
}

function resolvePuckPuck(a, b, r, restitution) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 0.0001;
  const minDist = r * 2;
  if (dist >= minDist) return;

  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;

  a.x -= nx * overlap * 0.5;
  a.y -= ny * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.y += ny * overlap * 0.5;

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const velAlongNormal = rvx * nx + rvy * ny;
  if (velAlongNormal > 0) return;

  const j = (-(1 + restitution) * velAlongNormal) / 2;
  const impX = j * nx;
  const impY = j * ny;

  a.vx -= impX;
  a.vy -= impY;
  b.vx += impX;
  b.vy += impY;
}

function Button({ children, onClick, kind = "default" }) {
  const base = {
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid rgba(0,0,0,0.18)",
    fontSize: 13,
    cursor: "pointer",
    userSelect: "none",
  };

  const variants = {
    default: { background: "#111827", color: "#fff" },
    secondary: { background: "#e5e7eb", color: "#111827" },
    outline: { background: "transparent", color: "#111827" },
  };

  return (
    <button onClick={onClick} style={{ ...base, ...(variants[kind] || variants.default) }}>
      {children}
    </button>
  );
}

export default function PuckHerdingBoard() {
  const cfg = useMemo(() => ({ ...DEFAULTS }), []);

  const containerRef = useRef(null);
  const rafRef = useRef(null);
  const lastTRef = useRef(nowMs());

  const [pucks, setPucks] = useState(() => makePucks(cfg));
  const pucksRef = useRef(pucks);
  useEffect(() => {
    pucksRef.current = pucks;
  }, [pucks]);

  const [running, setRunning] = useState(true);
  const runningRef = useRef(true);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  // Stick
  const stickRef = useRef({
    x: cfg.boardW * 0.15,
    y: cfg.boardH * 0.5,
    vx: 0,
    vy: 0,
    down: false,
    lastMoveT: nowMs(),
  });
  const [stickView, setStickView] = useState({
    x: stickRef.current.x,
    y: stickRef.current.y,
    down: false,
  });

  // Hold timer
  const [allHeld, setAllHeld] = useState(false);
  const [holdSeconds, setHoldSeconds] = useState(0);
  const [bestHoldSeconds, setBestHoldSeconds] = useState(0);
  const holdStartRef = useRef(null);

  // Zones
  const targetX = cfg.boardW - cfg.targetZoneW;
  const improveZoneX = cfg.boardW * 0.65;
  const negativeEndX = cfg.boardW * 0.35;

  // Green zone (target) labels
  const GREEN_LABELS = useMemo(
    () => [
      "JBO's",
      "Audits",
      "CMS's",
      "Everyone Safe",
      "Load Balance",
      "Hours Management",
    ],
    []
  );

  const NEG_ZONES = useMemo(() => {
    const labels = ["Low morale", "Damages", "Samsara events", "Time theft", "Low production"]; // left-to-right
    const seg = negativeEndX / labels.length;
    const mults = [2.2, 2.1, 2.0, 1.9, 1.8];
    const colors = [
      "rgba(239,68,68,0.10)",
      "rgba(239,68,68,0.09)",
      "rgba(239,68,68,0.085)",
      "rgba(239,68,68,0.08)",
      "rgba(239,68,68,0.075)",
    ];

    return labels.map((text, i) => {
      const x0 = i * seg;
      const x1 = (i + 1) * seg;
      return { text, x0, x1, mult: mults[i], bg: colors[i] };
    });
  }, [negativeEndX]);

  // Flash logic (no spammy setState inside the physics loop)
  const [zoneAlerts, setZoneAlerts] = useState(() => ({})); // { [zoneText]: true }
  const alertUntilRef = useRef({}); // { [zoneText]: timestamp }
  const lastZoneByPuckRef = useRef({}); // { [puckId]: zoneText | null }

  function reset() {
    setAllHeld(false);
    setHoldSeconds(0);
    holdStartRef.current = null;

    alertUntilRef.current = {};
    lastZoneByPuckRef.current = {};
    setZoneAlerts({});

    setPucks(makePucks(cfg));
    stickRef.current = {
      x: cfg.boardW * 0.15,
      y: cfg.boardH * 0.5,
      vx: 0,
      vy: 0,
      down: false,
      lastMoveT: nowMs(),
    };
    setStickView({ x: stickRef.current.x, y: stickRef.current.y, down: false });
  }

  function toLocalPoint(clientX, clientY) {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * cfg.boardW;
    const y = ((clientY - rect.top) / rect.height) * cfg.boardH;
    return { x, y };
  }

  function onPointerDown(e) {
    e.preventDefault();
    const pt = toLocalPoint(e.clientX, e.clientY);
    const s = stickRef.current;
    s.down = true;
    s.x = pt.x;
    s.y = pt.y;
    s.vx = 0;
    s.vy = 0;
    s.lastMoveT = nowMs();
    setStickView({ x: s.x, y: s.y, down: true });
  }

  function onPointerMove(e) {
    const s = stickRef.current;
    const pt = toLocalPoint(e.clientX, e.clientY);
    const t = nowMs();
    const dt = Math.max(0.001, (t - s.lastMoveT) / 1000);

    const vx = (pt.x - s.x) / dt;
    const vy = (pt.y - s.y) / dt;

    s.x = pt.x;
    s.y = pt.y;
    s.vx = clamp(vx, -cfg.maxSpeed * 3, cfg.maxSpeed * 3);
    s.vy = clamp(vy, -cfg.maxSpeed * 3, cfg.maxSpeed * 3);
    s.lastMoveT = t;

    if (s.down) setStickView({ x: s.x, y: s.y, down: true });
  }

  function onPointerUp() {
    const s = stickRef.current;
    s.down = false;
    setStickView({ x: s.x, y: s.y, down: false });
  }

  useEffect(() => {
    const tick = () => {
      const t = nowMs();
      const dt = clamp((t - lastTRef.current) / 1000, 0, 0.04);
      lastTRef.current = t;

      if (!runningRef.current) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const s = stickRef.current;
      const next = pucksRef.current.map((p) => ({ ...p }));

      // Physics
      for (const p of next) {
        // Which negative zone (if any)?
        const neg = NEG_ZONES.find((z) => p.x >= z.x0 && p.x < z.x1);
        const prevZone = lastZoneByPuckRef.current[p.id] ?? null;
        const currentZone = neg ? neg.text : null;

        // Flash when a puck ENTERS a zone
        if (currentZone && currentZone !== prevZone) {
          alertUntilRef.current[currentZone] = t + cfg.alertFlashMs;
        }
        lastZoneByPuckRef.current[p.id] = currentZone;

        // Zone multiplier
        let zoneMult = 1;
        if (neg) zoneMult = neg.mult;
        else if (p.x < improveZoneX) zoneMult = 1.25;
        else zoneMult = 0.95;

        // Wander
        p.wx = clamp(p.wx + randBetween(-0.12, 0.12) * dt, -1, 1);
        p.wy = clamp(p.wy + randBetween(-0.12, 0.12) * dt, -1, 1);
        const w = normalize(p.wx, p.wy);
        const wanderForce = cfg.wanderStrength * p.wanderMult * zoneMult;
        p.vx += w.x * wanderForce * dt;
        p.vy += w.y * wanderForce * dt;

        // Goal leak
        if (p.x > targetX) {
          const depth = clamp((p.x - targetX) / cfg.targetZoneW, 0, 1);
          p.vx -= cfg.goalLeakStrength * p.leakMult * (0.35 + 0.65 * depth) * dt;
        }

        // Jitter
        if (Math.random() < cfg.jitterChancePerSec * p.jitterMult * zoneMult * dt) {
          const j = normalize(randBetween(-1, 1), randBetween(-1, 1));
          p.vx += j.x * cfg.jitterStrength * p.jitterMult;
          p.vy += j.y * cfg.jitterStrength * p.jitterMult;
        }

        // Stick push
        if (s.down) {
          const dx = p.x - s.x;
          const dy = p.y - s.y;
          const d = length(dx, dy);
          const reach = cfg.puckRadius + cfg.stickRadius + 6;
          if (d < reach) {
            const n = normalize(dx, dy);
            const closeness = 1 - d / reach;
            const impulse = (cfg.stickPushStrength * closeness) / p.stubbornness;
            p.vx += n.x * impulse * dt + s.vx * 0.08;
            p.vy += n.y * impulse * dt + s.vy * 0.08;
          }
        }

        // Cap speed
        const maxSp = cfg.maxSpeed * p.speedMult;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > maxSp) {
          p.vx = (p.vx / sp) * maxSp;
          p.vy = (p.vy / sp) * maxSp;
        }

        // Integrate
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        // Damping
        p.vx *= cfg.damping;
        p.vy *= cfg.damping;

        // Walls
        const r = cfg.puckRadius;
        if (p.x < r) {
          p.x = r;
          p.vx = Math.abs(p.vx) * cfg.wallBounce;
        }
        if (p.x > cfg.boardW - r) {
          p.x = cfg.boardW - r;
          p.vx = -Math.abs(p.vx) * cfg.wallBounce;
        }
        if (p.y < r) {
          p.y = r;
          p.vy = Math.abs(p.vy) * cfg.wallBounce;
        }
        if (p.y > cfg.boardH - r) {
          p.y = cfg.boardH - r;
          p.vy = -Math.abs(p.vy) * cfg.wallBounce;
        }
      }

      // Collisions
      for (let i = 0; i < next.length; i++) {
        for (let j = i + 1; j < next.length; j++) {
          resolvePuckPuck(next[i], next[j], cfg.puckRadius, cfg.puckRestitution);
        }
      }

      // Stick friction
      s.vx *= cfg.stickFriction;
      s.vy *= cfg.stickFriction;

      // Hold tracking
      const allInTarget = next.every((p) => p.x >= targetX + cfg.puckRadius * 0.4);
      if (allInTarget) {
        if (holdStartRef.current == null) holdStartRef.current = t;
        const secs = (t - holdStartRef.current) / 1000;
        setHoldSeconds(secs);
        setBestHoldSeconds((best) => Math.max(best, secs));
        setAllHeld(true);
      } else {
        holdStartRef.current = null;
        setHoldSeconds(0);
        setAllHeld(false);
      }

      // Compute active alerts for this frame
      const active = {};
      const until = alertUntilRef.current;
      for (const k of Object.keys(until)) {
        if (until[k] > t) active[k] = true;
      }
      // Drop expired
      for (const k of Object.keys(until)) {
        if (until[k] <= t) delete until[k];
      }

      setZoneAlerts((prev) => {
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(active);
        if (prevKeys.length === nextKeys.length && prevKeys.every((k) => active[k])) return prev;
        return active;
      });

      setPucks(next);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [cfg, NEG_ZONES, improveZoneX, targetX]);

  const inTargetCount = useMemo(() => {
    const r = cfg.puckRadius;
    return pucks.filter((p) => p.x >= targetX + r * 0.4).length;
  }, [pucks, cfg.puckRadius, targetX]);

  // Styles
  const page = {
    width: "100%",
    maxWidth: 1100,
    margin: "0 auto",
    padding: 16,
    fontFamily: "Arial, sans-serif",
    color: "#111827",
  };
  const card = {
    border: "1px solid rgba(0,0,0,0.12)",
    borderRadius: 16,
    padding: 16,
    background: "#fff",
    boxShadow: "0 6px 22px rgba(0,0,0,0.06)",
  };
  const headerRow = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 12,
    flexWrap: "wrap",
  };
  const statsRow = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
  const boardWrap = {
    position: "relative",
    width: "100%",
    aspectRatio: `${cfg.boardW} / ${cfg.boardH}`,
    userSelect: "none",
    touchAction: "none",
    borderRadius: 18,
    overflow: "hidden",
    border: "1px solid rgba(0,0,0,0.12)",
  };

  return (
    <div style={page}>
      <div style={card}>
        <div style={headerRow}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>Puck Herding</div>
            <div style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }}>
              Use your stick to keep nudging the pucks into the target zone.
            </div>
          </div>

          <div style={statsRow}>
            <div style={{ fontSize: 13 }}>
              In zone: <span style={{ fontWeight: 800 }}>{inTargetCount}</span>/{cfg.puckCount}
            </div>
            <div style={{ fontSize: 13, opacity: 0.75 }}>Hold: {holdSeconds.toFixed(1)}s</div>
            <div style={{ fontSize: 13, opacity: 0.75 }}>Best: {bestHoldSeconds.toFixed(1)}s</div>

            <Button kind={running ? "secondary" : "default"} onClick={() => setRunning((r) => !r)}>
              {running ? "Pause" : "Resume"}
            </Button>
            <Button kind="outline" onClick={reset}>
              Reset
            </Button>
          </div>
        </div>

        <div
          ref={containerRef}
          style={boardWrap}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {/* Board base */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "linear-gradient(135deg, #0b1220, #0f172a)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
            }}
          />

          {/* Negative zone backgrounds */}
          {NEG_ZONES.map((z, idx) => {
            const flashing = !!zoneAlerts[z.text];
            return (
              <div
                key={idx}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${(z.x0 / cfg.boardW) * 100}%`,
                  width: `${((z.x1 - z.x0) / cfg.boardW) * 100}%`,
                  background: flashing ? "rgba(239,68,68,0.33)" : z.bg,
                  boxShadow: flashing ? "inset 0 0 32px rgba(239,68,68,0.65)" : "none",
                  transition: "background 120ms linear, box-shadow 120ms linear",
                }}
              />
            );
          })}

          {/* Improvement zone */}
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${(negativeEndX / cfg.boardW) * 100}%`,
              width: `${((improveZoneX - negativeEndX) / cfg.boardW) * 100}%`,
              background: "rgba(234,179,8,0.08)",
            }}
          />

          {/* Center line */}
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "50%",
              width: 1,
              background: "rgba(255,255,255,0.08)",
            }}
          />

          {/* Target zone */}
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: 0,
              width: `${(cfg.targetZoneW / cfg.boardW) * 100}%`,
              background: "rgba(34,197,94,0.12)",
              borderLeft: "1px solid rgba(255,255,255,0.12)",
            }}
          />

          {/* Green zone vertical labels */}
          {GREEN_LABELS.map((text, idx) => {
            const x0 = cfg.boardW - cfg.targetZoneW;
            const seg = cfg.boardH / GREEN_LABELS.length;
            const y0 = idx * seg;
            const yMid = y0 + seg / 2;
            return (
              <div
                key={text}
                style={{
                  position: "absolute",
                  left: `${(x0 / cfg.boardW) * 100}%`,
                  width: `${(cfg.targetZoneW / cfg.boardW) * 100}%`,
                  top: `${(yMid / cfg.boardH) * 100}%`,
                  transform: "translateY(-50%)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    color: "rgba(220,252,231,0.78)",
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    userSelect: "none",
                    whiteSpace: "nowrap",
                    textShadow: "0 0 10px rgba(34,197,94,0.35)",
                  }}
                >
                  {text}
                </div>
              </div>
            );
          })}

          {/* Labels */}
          <div
            style={{
              position: "absolute",
              top: 10,
              left: 10,
              fontSize: 12,
              padding: "6px 8px",
              borderRadius: 10,
              background: "rgba(239,68,68,0.18)",
              color: "rgba(254,226,226,0.95)",
              border: "1px solid rgba(239,68,68,0.35)",
            }}
          >
            Negative zones
          </div>

          <div
            style={{
              position: "absolute",
              top: 10,
              left: `${(negativeEndX / cfg.boardW) * 100 + 2}%`,
              fontSize: 12,
              padding: "6px 8px",
              borderRadius: 10,
              background: "rgba(234,179,8,0.18)",
              color: "rgba(254,243,199,0.95)",
              border: "1px solid rgba(234,179,8,0.35)",
            }}
          >
            Improved, but needs more improvement
          </div>

          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              fontSize: 12,
              padding: "6px 8px",
              borderRadius: 10,
              background: "rgba(34,197,94,0.22)",
              color: "rgba(220,252,231,0.95)",
              border: "1px solid rgba(34,197,94,0.40)",
            }}
          >
            In compliance • Profitable • Safe • Stay here
          </div>

          {/* Negative zone vertical labels */}
          {NEG_ZONES.map((z, idx) => {
            const leftPct = (z.x0 / cfg.boardW) * 100;
            const widthPct = ((z.x1 - z.x0) / cfg.boardW) * 100;
            const flashing = !!zoneAlerts[z.text];
            return (
              <div
                key={idx}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    transform: "rotate(-90deg)",
                    color: flashing ? "rgba(254,226,226,0.96)" : "rgba(254,226,226,0.55)",
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    userSelect: "none",
                    whiteSpace: "nowrap",
                    textShadow: flashing ? "0 0 12px rgba(239,68,68,0.85)" : "none",
                    transition: "color 120ms linear, text-shadow 120ms linear",
                  }}
                >
                  {z.text}
                </div>
              </div>
            );
          })}

          {/* Pucks */}
          {pucks.map((p) => {
            const leftPct = (p.x / cfg.boardW) * 100;
            const topPct = (p.y / cfg.boardH) * 100;
            const inZone = p.x >= targetX + cfg.puckRadius * 0.4;
            return (
              <div
                key={p.id}
                style={{
                  position: "absolute",
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  width: `${((cfg.puckRadius * 2) / cfg.boardW) * 100}%`,
                  height: `${((cfg.puckRadius * 2) / cfg.boardH) * 100}%`,
                  transform: "translate(-50%, -50%)",
                  borderRadius: 999,
                  background: `hsl(${p.hue} 85% 55% / ${inZone ? 0.95 : 0.9})`,
                  boxShadow: inZone
                    ? "0 10px 24px rgba(34,197,94,0.18), inset 0 0 0 2px rgba(255,255,255,0.18)"
                    : "0 10px 24px rgba(0,0,0,0.35), inset 0 0 0 2px rgba(255,255,255,0.16)",
                  border: "1px solid rgba(255,255,255,0.14)",
                }}
              />
            );
          })}

          {/* Stick */}
          <div
            style={{
              position: "absolute",
              left: `${(stickView.x / cfg.boardW) * 100}%`,
              top: `${(stickView.y / cfg.boardH) * 100}%`,
              width: `${((cfg.stickRadius * 2) / cfg.boardW) * 100}%`,
              height: `${((cfg.stickRadius * 2) / cfg.boardH) * 100}%`,
              transform: "translate(-50%, -50%)",
              borderRadius: 999,
              pointerEvents: "none",
              background: stickView.down ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.08)",
              border: stickView.down ? "2px solid rgba(255,255,255,0.38)" : "1px solid rgba(255,255,255,0.22)",
              boxShadow: stickView.down ? "0 12px 30px rgba(255,255,255,0.10)" : "none",
              backdropFilter: "blur(6px)",
            }}
          />

          {/* Status chip */}
          <div
            style={{
              position: "absolute",
              left: 10,
              bottom: 10,
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 999,
              background: allHeld ? "rgba(34, 197, 94, 0.18)" : "rgba(255,255,255,0.10)",
              color: allHeld ? "rgba(220,252,231,0.95)" : "rgba(226,232,240,0.95)",
              border: allHeld ? "1px solid rgba(34,197,94,0.35)" : "1px solid rgba(255,255,255,0.14)",
              pointerEvents: "none",
            }}
          >
            {allHeld ? "All held in zone" : "Keep herding"}
          </div>
        </div>

        <div style={{ marginTop: 12, fontSize: 13, opacity: 0.7 }}>
          Tip: Click or press and drag the stick into pucks to nudge them. When you get all of them into the green target
          zone, your job is to keep them there.
        </div>
      </div>
    </div>
  );
}
