/**
 * The page outline, in render order, shared by the article and its table of
 * contents so the two can never drift.
 *
 * The ids are load-bearing well beyond this file: `#security` is linked from
 * /not-found, /roadmap, /explore, the landing security panel, the landing
 * footer and the site footer, and `#automation` from the Automate console.
 * Renaming one silently degrades an inbound link rather than breaking a build.
 */
export const DOC_SECTIONS = [
  { id: "release", label: "Current release map" },
  { id: "authorities", label: "Three authorities" },
  { id: "quickstart", label: "Quickstart" },
  { id: "composer", label: "Execution policy composer" },
  { id: "token", label: "0xZAPS utility" },
  { id: "policy", label: "Policy schema" },
  { id: "api", label: "Simulation API" },
  { id: "templates", label: "Templates" },
  { id: "automation", label: "Automation (v3 / v3.1)" },
  { id: "agents", label: "Connecting an agent" },
  { id: "lifecycle", label: "Execution lifecycle" },
  { id: "sdk", label: "SDK surface" },
  { id: "security", label: "Security model" },
  { id: "controls", label: "Controls" },
  { id: "threats", label: "Threat model" },
  { id: "gates", label: "Production gates" },
] as const;
