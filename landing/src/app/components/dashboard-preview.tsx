"use client";

import dynamic from "next/dynamic";

const InteractiveGraph = dynamic(
  () =>
    import("./interactive-graph").then((m) => ({
      default: m.InteractiveGraph,
    })),
  { ssr: false },
);

/**
 * Dashboard frame with sidebar on the left and the 3D interactive
 * knowledge graph as the main content area.
 */
export function DashboardPreview() {
  const navItems = [
    { label: "Overview", icon: "◆", active: true },
    { label: "Workspaces", icon: "⊞", active: false },
    { label: "Query", icon: "⊕", active: false, debug: true },
    { label: "Documents", icon: "⊡", active: false, debug: true },
    { label: "Jobs", icon: "⬡", active: false, debug: true },
    { label: "Settings", icon: "⚙", active: false, secondary: true },
  ];

  return (
    <div
      className="dashboard-preview-root"
      style={{
        display: "flex",
        height: "100%",
        width: "100%",
        backgroundColor: "oklch(0.07 0.015 260)",
        borderRadius: "inherit",
        overflow: "hidden",
      }}
    >
      {/* ── Sidebar ── */}
      <div
        className="dashboard-sidebar"
        style={{
          width: "200px",
          minWidth: "200px",
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid oklch(1 0 0 / 6%)",
          backgroundColor: "oklch(0.09 0.01 260)",
          padding: "12px 8px",
          gap: "2px",
        }}
      >
        {/* Logo */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "8px 12px",
            marginBottom: "12px",
          }}
        >
          <div
            style={{
              width: "24px",
              height: "24px",
              borderRadius: "6px",
              backgroundColor: "oklch(0.72 0.14 200 / 0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "oklch(0.72 0.14 200)",
              fontWeight: 900,
              fontSize: "11px",
            }}
          >
            Ez
          </div>
          <span
            style={{
              fontWeight: 900,
              fontSize: "12px",
              color: "oklch(0.97 0.005 260)",
            }}
          >
            OPEN<span style={{ color: "oklch(0.72 0.14 200)" }}>EZ</span>
          </span>
        </div>

        <div
          style={{
            padding: "4px 12px",
            fontSize: "9px",
            fontWeight: 600,
            color: "oklch(0.52 0.02 260)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Navigation
        </div>

        {navItems
          .filter((n) => !n.debug && !n.secondary)
          .map((item) => (
            <div
              key={item.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: item.active ? 600 : 400,
                color: item.active
                  ? "oklch(0.72 0.14 200)"
                  : "oklch(0.65 0.01 260)",
                backgroundColor: item.active
                  ? "oklch(0.72 0.14 200 / 0.1)"
                  : "transparent",
              }}
            >
              <span style={{ fontSize: "12px", opacity: 0.7 }}>{item.icon}</span>
              <span>{item.label}</span>
            </div>
          ))}

        <div
          style={{
            height: "1px",
            backgroundColor: "oklch(1 0 0 / 6%)",
            margin: "6px 12px",
          }}
        />

        <div
          style={{
            padding: "4px 12px",
            fontSize: "9px",
            fontWeight: 600,
            color: "oklch(0.52 0.02 260)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Debug
        </div>

        {navItems
          .filter((n) => n.debug)
          .map((item) => (
            <div
              key={item.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                color: "oklch(0.65 0.01 260)",
              }}
            >
              <span style={{ fontSize: "12px", opacity: 0.7 }}>{item.icon}</span>
              <span>{item.label}</span>
            </div>
          ))}

        <div
          style={{
            height: "1px",
            backgroundColor: "oklch(1 0 0 / 6%)",
            margin: "6px 12px",
          }}
        />

        {navItems
          .filter((n) => n.secondary)
          .map((item) => (
            <div
              key={item.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                color: "oklch(0.65 0.01 260)",
              }}
            >
              <span style={{ fontSize: "12px", opacity: 0.7 }}>{item.icon}</span>
              <span>{item.label}</span>
            </div>
          ))}
      </div>

      {/* ── Main content: Interactive 3D graph ── */}
      <div
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Title bar */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: "linear-gradient(180deg, oklch(0.07 0.015 260 / 0.8) 0%, transparent 100%)",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              fontSize: "15px",
              fontWeight: 700,
              color: "oklch(0.97 0.005 260)",
              letterSpacing: "-0.02em",
            }}
          >
            openez
          </span>
          <span style={{ fontSize: "11px", color: "oklch(0.52 0.02 260)" }}>
            /openez-graph
          </span>
        </div>

        {/* Full-bleed graph */}
        <InteractiveGraph />
      </div>
    </div>
  );
}
