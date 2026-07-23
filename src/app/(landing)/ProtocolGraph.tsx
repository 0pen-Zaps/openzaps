"use client";

import { useState } from "react";
import type { GraphEdge, GraphNode } from "./data";
import styles from "./landing.module.css";

/**
 * The protocol constellation. Positions are hand-placed percentages shared by
 * the HTML node buttons (keyboard-accessible) and the SVG edge layer beneath
 * them, so both always agree. Bright nodes carry deployed routes; dim ones are
 * typed into the catalog. Selecting a node lights its connections and fills
 * the detail panel.
 */

const POSITIONS: Record<string, { x: number; y: number }> = {
  "uniswap-v4": { x: 50, y: 34 },
  "openzaps-vault": { x: 66, y: 62 },
  "uniswap-v3": { x: 30, y: 18 },
  aerodrome: { x: 14, y: 40 },
  morpho: { x: 26, y: 72 },
  aave: { x: 42, y: 86 },
  compound: { x: 78, y: 22 },
  "canonical-bridge": { x: 88, y: 48 },
  "wrapped-native": { x: 68, y: 10 },
};

const CENTER = { x: 52, y: 48 };

export function ProtocolGraph({
  nodes,
  edges,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>("uniswap-v4");
  const selected = nodes.find((n) => n.id === selectedId) ?? nodes[0];

  return (
    <div className={styles.graph}>
      <div className={styles.graphStage}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className={styles.graphSvg}
          aria-hidden="true"
        >
          {/* Spokes: every protocol composes through the core. */}
          {nodes.map((node) => {
            const p = POSITIONS[node.id];
            if (!p) return null;
            const active = node.id === selected?.id;
            return (
              <line
                key={`spoke-${node.id}`}
                x1={CENTER.x}
                y1={CENTER.y}
                x2={p.x}
                y2={p.y}
                className={styles.graphSpoke}
                data-live={node.deployed || undefined}
                data-active={active || undefined}
              />
            );
          })}
          {/* Composition edges: two protocols touched by one block. */}
          {edges.map((edge) => {
            const a = POSITIONS[edge.a];
            const b = POSITIONS[edge.b];
            if (!a || !b) return null;
            const active = selected && (edge.a === selected.id || edge.b === selected.id);
            return (
              <line
                key={`${edge.a}-${edge.b}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={styles.graphPair}
                data-live={edge.live || undefined}
                data-active={active || undefined}
              />
            );
          })}
        </svg>

        <span className={styles.graphCore} aria-hidden="true">
          <span className={styles.graphCoreDot} />
          <span className={`${styles.graphCoreLabel} mono`}>openzaps</span>
        </span>

        {nodes.map((node) => {
          const p = POSITIONS[node.id];
          if (!p) return null;
          return (
            <button
              key={node.id}
              type="button"
              className={styles.graphNode}
              style={{ left: `${p.x}%`, top: `${p.y}%` }}
              data-live={node.deployed || undefined}
              data-active={node.id === selected?.id || undefined}
              onClick={() => setSelectedId(node.id)}
              onPointerEnter={() => setSelectedId(node.id)}
              onFocus={() => setSelectedId(node.id)}
              aria-pressed={node.id === selected?.id}
            >
              <span className={styles.graphNodeDot} aria-hidden="true" />
              {node.name}
            </button>
          );
        })}
      </div>

      {selected ? (
        <aside className={styles.graphPanel}>
          <div className={styles.graphPanelHead}>
            <h3 className={styles.graphPanelName}>{selected.name}</h3>
            <span
              className={`${styles.cardStatus} mono`}
              data-live={selected.deployed || undefined}
            >
              {selected.deployed ? "deployed routes" : "catalog"}
            </span>
          </div>
          <p className={styles.graphPanelBody}>
            {selected.deployed
              ? "Carries live, bounded routes on Robinhood Chain today."
              : "Typed into the block catalog — designs compile against it; no adapter is deployed yet."}
          </p>
          {selected.actions.length > 0 ? (
            <ul className={`${styles.graphActions} mono`}>
              {selected.actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
