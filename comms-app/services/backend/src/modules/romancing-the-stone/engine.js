/**
 * Romancing the Stone — reward path engine.
 *
 * A path is a one-way graph. Every node is one of:
 *
 *   choice    doors shown as pictures (an optional caption per door). The
 *             seeker picks one and cannot go back.
 *   question  a prompt with multiple-choice answers; each answer leads on.
 *   chance    a sealed spin; the server picks an outcome by weight.
 *   reward    the end of the path: what the seeker actually won.
 *
 * Branching nodes carry `options`, each with a `to` pointing at the next node,
 * and an optional `reveal` line shown after it is picked ("Candy? Not quite.").
 *
 * This file has no dependencies and no I/O so the same code runs on the
 * server (authoritative walk, redaction) and in the app (builder validation,
 * local preview). The app keeps a verbatim copy in src/lib/engine.js.
 */

export const ENGINE_VERSION = 1;

export const NODE_TYPES = Object.freeze(["choice", "question", "chance", "reward"]);
export const GEM_COLORS = Object.freeze([
  "cyan", "violet", "pink", "aqua", "orchid", "rose", "white", "onyx",
]);

export const LIMITS = Object.freeze({
  nodes: 150,
  depth: 12,
  choiceOptions: [2, 6],
  questionOptions: [2, 6],
  chanceOptions: [2, 8],
  prompt: 160,
  label: 40,
  text: 80,
  reveal: 160,
  title: 80,
  description: 400,
  weight: [1, 100],
});

const ID_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"]);
const ID = { test: (value) => ID_PATTERN.test(value) && !RESERVED_IDS.has(value) };
const ICON = /^[a-z0-9-]{1,40}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Own keys only: a step called "constructor" must not match Object.prototype.
const has = (object, key) => isObject(object) && typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);
const nodeOf = (graph, id) => (has(graph?.nodes, id) ? graph.nodes[id] : null);

/** Route counts above this are reported as the cap; nothing is ever enumerated. */
export const ROUTE_CAP = 1_000_000;
const str = (value) => (typeof value === "string" ? value : "");
const hasControlChars = (value) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

function checkText(errors, where, value, { max, required = false, field }) {
  if (value === undefined || value === null || value === "") {
    if (required) errors.push(`${where}: ${field} is required`);
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${where}: ${field} must be text`);
    return;
  }
  if (required && !value.trim()) errors.push(`${where}: ${field} is required`);
  if (value.length > max) errors.push(`${where}: ${field} is longer than ${max} characters`);
  if (hasControlChars(value)) errors.push(`${where}: ${field} has unsupported characters`);
}

function checkIcon(errors, where, value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) errors.push(`${where}: pick a picture`);
    return;
  }
  if (typeof value !== "string" || !ICON.test(value)) errors.push(`${where}: unknown picture`);
}

function checkColor(errors, where, value) {
  if (value === undefined || value === null || value === "") return;
  if (!GEM_COLORS.includes(value)) errors.push(`${where}: unknown color`);
}

/**
 * Validate a path graph. Returns { ok, errors, stats }.
 * Every structural rule the server enforces lives here.
 */
export function validateGraph(graph) {
  const errors = [];
  if (!isObject(graph) || !isObject(graph.nodes)) {
    return { ok: false, errors: ["The path is empty."], stats: null };
  }
  const ids = Object.keys(graph.nodes);
  if (ids.length === 0) errors.push("The path has no steps.");
  if (ids.length > LIMITS.nodes) errors.push(`A path can have at most ${LIMITS.nodes} steps.`);
  if (!ID.test(str(graph.start)) || !has(graph.nodes, graph.start)) errors.push("The path has no starting step.");
  else if (graph.nodes[graph.start]?.type === "reward") errors.push("A path starts with doors, a question or a spin.");

  for (const id of ids) {
    const node = graph.nodes[id];
    const where = `Step ${id}`;
    if (!ID.test(id)) {
      errors.push(`${where}: invalid id`);
      continue;
    }
    if (!isObject(node) || !NODE_TYPES.includes(node.type)) {
      errors.push(`${where}: unknown step type`);
      continue;
    }
    if (node.type === "reward") {
      checkText(errors, where, node.title, { max: LIMITS.title, required: true, field: "reward title" });
      checkText(errors, where, node.description, { max: LIMITS.description, field: "description" });
      checkText(errors, where, node.reveal, { max: LIMITS.reveal, field: "reveal line" });
      checkIcon(errors, where, node.icon, true);
      checkColor(errors, where, node.color);
      if (node.options !== undefined && !(Array.isArray(node.options) && node.options.length === 0)) {
        errors.push(`${where}: a reward ends the path and cannot lead anywhere`);
      }
      continue;
    }

    checkText(errors, where, node.prompt, {
      max: LIMITS.prompt,
      required: node.type === "question",
      field: "prompt",
    });
    const options = Array.isArray(node.options) ? node.options : [];
    const [min, max] =
      node.type === "choice"
        ? LIMITS.choiceOptions
        : node.type === "question"
          ? LIMITS.questionOptions
          : LIMITS.chanceOptions;
    if (options.length < min || options.length > max) {
      errors.push(`${where}: needs between ${min} and ${max} ${node.type === "choice" ? "doors" : "options"}`);
    }
    const seen = new Set();
    options.forEach((option, index) => {
      const at = `${where}, option ${index + 1}`;
      if (!isObject(option)) {
        errors.push(`${at}: invalid`);
        return;
      }
      if (!ID.test(str(option.id))) errors.push(`${at}: invalid id`);
      else if (seen.has(option.id)) errors.push(`${at}: duplicate id`);
      seen.add(option.id);
      if (!ID.test(str(option.to)) || !has(graph.nodes, option.to)) errors.push(`${at}: leads nowhere`);
      else if (option.to === id) errors.push(`${at}: cannot lead back to itself`);
      checkText(errors, at, option.reveal, { max: LIMITS.reveal, field: "reveal line" });
      if (node.type === "choice") {
        checkIcon(errors, at, option.icon, true);
        checkColor(errors, at, option.color);
        checkText(errors, at, option.label, { max: LIMITS.label, field: "caption" });
      } else if (node.type === "question") {
        checkText(errors, at, option.text, { max: LIMITS.text, required: true, field: "answer" });
        checkIcon(errors, at, option.icon, false);
      } else {
        const weight = option.weight === undefined ? 1 : option.weight;
        if (!Number.isInteger(weight) || weight < LIMITS.weight[0] || weight > LIMITS.weight[1]) {
          errors.push(`${at}: odds must be a whole number from ${LIMITS.weight[0]} to ${LIMITS.weight[1]}`);
        }
        checkText(errors, at, option.label, { max: LIMITS.label, field: "label" });
      }
    });
  }

  if (errors.length) return { ok: false, errors, stats: null };

  // One-way: no cycles, every step reachable, bounded depth. Each step is
  // measured once (memoised), so a graph whose options share destinations
  // costs time in proportion to its size, not to its number of routes.
  const state = new Map();
  const measured = new Map();
  const rewards = new Set();
  let cycle = false;
  const measure = (id) => {
    if (measured.has(id)) return measured.get(id);
    if (state.get(id) === "open") {
      cycle = true;
      return { depth: 0, routes: 0 };
    }
    state.set(id, "open");
    const node = graph.nodes[id];
    let result;
    if (node.type === "reward") {
      rewards.add(id);
      result = { depth: 1, routes: 1 };
    } else {
      let depth = 0;
      let routes = 0;
      for (const option of node.options) {
        const child = measure(option.to);
        depth = Math.max(depth, child.depth);
        routes = Math.min(ROUTE_CAP, routes + child.routes);
      }
      result = { depth: depth + 1, routes };
    }
    state.set(id, "done");
    measured.set(id, result);
    return result;
  };
  const root = measure(graph.start);
  if (cycle) errors.push("A path only goes forward — one of its steps loops back.");
  const unreachable = ids.filter((id) => !state.has(id));
  if (unreachable.length) errors.push(`Some steps can never be reached (${unreachable.slice(0, 5).join(", ")}).`);
  if (root.depth > LIMITS.depth) errors.push(`A path can be at most ${LIMITS.depth} steps deep.`);
  if (!rewards.size) errors.push("The path needs at least one reward.");

  return errors.length
    ? { ok: false, errors, stats: null }
    : { ok: true, errors: [], stats: { steps: ids.length, depth: root.depth, rewards: rewards.size, routes: root.routes } };
}

/** The view of a node a seeker is allowed to see: no destinations, no reveals. */
export function publicNode(graph, nodeId) {
  const node = nodeOf(graph, nodeId);
  if (!node) return null;
  if (node.type === "reward") {
    return {
      id: nodeId,
      type: "reward",
      title: node.title,
      description: node.description || "",
      icon: node.icon,
      color: node.color || "",
      reveal: node.reveal || "",
    };
  }
  if (node.type === "choice") {
    return {
      id: nodeId,
      type: "choice",
      prompt: node.prompt || "",
      options: node.options.map((option) => ({
        id: option.id,
        icon: option.icon,
        color: option.color || "",
        label: option.label || "",
      })),
    };
  }
  if (node.type === "question") {
    return {
      id: nodeId,
      type: "question",
      prompt: node.prompt,
      options: node.options.map((option) => ({ id: option.id, text: option.text, icon: option.icon || "" })),
    };
  }
  return { id: nodeId, type: "chance", prompt: node.prompt || "", count: node.options.length };
}

/** Pick a chance outcome. `randomInt(max)` returns an integer in [0, max). */
export function pickChance(node, randomInt) {
  const weights = node.options.map((option) => (option.weight === undefined ? 1 : option.weight));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = randomInt(total);
  for (let index = 0; index < node.options.length; index += 1) {
    if (roll < weights[index]) return node.options[index];
    roll -= weights[index];
  }
  return node.options[node.options.length - 1];
}

export class PathStepError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Take one step from `nodeId`. For a chance node `optionId` is ignored and the
 * outcome is drawn with `randomInt`. Returns the public record of the step and
 * where the path goes next.
 */
export function takeStep(graph, nodeId, optionId, randomInt) {
  const node = nodeOf(graph, nodeId);
  if (!node) throw new PathStepError("unknown_step");
  if (node.type === "reward") throw new PathStepError("path_finished");
  const option =
    node.type === "chance"
      ? pickChance(node, randomInt)
      : node.options.find((candidate) => candidate.id === optionId);
  if (!option) throw new PathStepError("unknown_option");
  const next = nodeOf(graph, option.to);
  if (!next) throw new PathStepError("broken_path");
  return {
    record: {
      nodeId,
      type: node.type,
      prompt: node.prompt || "",
      optionId: option.id,
      icon: option.icon || "",
      color: option.color || "",
      label: node.type === "question" ? option.text : option.label || "",
      reveal: option.reveal || "",
    },
    nextId: option.to,
    finished: next.type === "reward",
  };
}

/** Every reward in the path, for the builder and keepers. */
export function listRewards(graph) {
  return Object.entries(isObject(graph?.nodes) ? graph.nodes : {})
    .filter(([, node]) => node?.type === "reward")
    .map(([id, node]) => ({ id, title: node.title, icon: node.icon, color: node.color || "" }));
}

/** A reward's snapshot as stored on a finished run. */
export function rewardSnapshot(graph, nodeId) {
  const node = nodeOf(graph, nodeId);
  return {
    nodeId,
    title: node.title,
    description: node.description || "",
    icon: node.icon,
    color: node.color || "",
    reveal: node.reveal || "",
  };
}
