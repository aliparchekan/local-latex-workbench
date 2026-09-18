export const DEFAULT_PANES = { source: 31, agent: 27 };
export const PANE_HANDLE_SIZE = 5;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function validPaneLayout(value) {
  if (!value || typeof value !== "object"
    || !Number.isFinite(value.source) || !Number.isFinite(value.agent)) return null;
  return { source: clamp(value.source, 15, 65), agent: clamp(value.agent, 15, 65) };
}

// Keep a usable paper column even when saved proportions meet a smaller window.
// Collapsing a pane never overwrites its saved width.
export function fitPaneLayout(layout, width, sourceVisible = true, agentVisible = true) {
  const total = Number.isFinite(width) && width > 0 ? width : 1440;
  const handles = (Number(sourceVisible) + Number(agentVisible)) * PANE_HANDLE_SIZE;
  const minimum = Math.min(200, (total - handles) / 3);
  const paperMin = Math.min(280, (total - handles) / 3);
  const budget = total - handles - paperMin;
  let source = sourceVisible ? Math.max(minimum, total * layout.source / 100) : 0;
  let agent = agentVisible ? Math.max(minimum, total * layout.agent / 100) : 0;
  if (source + agent > budget) {
    const sourceFloor = sourceVisible ? minimum : 0;
    const agentFloor = agentVisible ? minimum : 0;
    const flexible = source + agent - sourceFloor - agentFloor;
    const ratio = flexible ? Math.max(0, (budget - sourceFloor - agentFloor) / flexible) : 0;
    source = sourceFloor + (source - sourceFloor) * ratio;
    agent = agentFloor + (agent - agentFloor) * ratio;
  }
  return { source, agent, minimum, sourceMax: budget - agent, agentMax: budget - source };
}
