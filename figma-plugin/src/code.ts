/**
 * Framelink Exporter — Figma plugin that serializes the current selection (or
 * entire page) into the exact JSON shape returned by the Figma REST API
 * (GetFileNodesResponse / GetFileResponse), plus a `framelinkExport` metadata
 * block carrying an asset manifest (PNGs, SVGs, image-fill bytes).
 *
 * Why this exists: The Figma REST API has aggressive rate limits on free plans.
 * This plugin lets designers export the relevant subtree once, commit the JSON
 * (and an `<filename>.assets/` sidecar folder) alongside the codebase, and let
 * AI coding tools consume it locally.
 */

const PLUGIN_VERSION = "1.3.0";

// Image scale for rendered frame screenshots. @2x is a good tradeoff between
// fidelity (handles retina, small text legible) and file size.
const FRAME_IMAGE_SCALE = 2;

// ── Debug logging ────────────────────────────────────────────────────────────
// View these in Figma desktop via Plugins → Development → Open Console.
// Flip DEBUG to false to silence everything before shipping.
const DEBUG = true;
const LOG_PREFIX = "[framelink]";

function log(...args: unknown[]): void {
  if (DEBUG) console.log(LOG_PREFIX, ...args);
}
function warn(...args: unknown[]): void {
  if (DEBUG) console.warn(LOG_PREFIX, ...args);
}
function error(...args: unknown[]): void {
  console.error(LOG_PREFIX, ...args);
}
function now(): number {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
function ms(start: number): string {
  return `${(now() - start).toFixed(0)}ms`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rgbaToApi(color: RGB | RGBA): { r: number; g: number; b: number; a: number } {
  return {
    r: color.r,
    g: color.g,
    b: color.b,
    a: "a" in color ? color.a : 1,
  };
}

function colorToApi(paint: Paint): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: paint.type,
    visible: paint.visible ?? true,
    opacity: paint.opacity ?? 1,
    blendMode: paint.blendMode,
  };

  if (paint.type === "SOLID") {
    base.color = rgbaToApi(paint.color);
  }

  if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR" ||
    paint.type === "GRADIENT_DIAMOND"
  ) {
    base.gradientHandlePositions = paint.gradientTransform
      ? transformToHandlePositions(paint.gradientTransform)
      : [];
    base.gradientStops = paint.gradientStops?.map((s) => ({
      color: rgbaToApi(s.color),
      position: s.position,
    }));
  }

  if (paint.type === "IMAGE") {
    base.scaleMode = paint.scaleMode;
    base.imageRef = paint.imageHash;
    if (paint.imageTransform) {
      base.imageTransform = paint.imageTransform;
    }
  }

  return base;
}

function transformToHandlePositions(
  transform: Transform,
): Array<{ x: number; y: number }> {
  const [[a, b, tx], [c, d, ty]] = transform;
  return [
    { x: tx, y: ty },
    { x: a + tx, y: c + ty },
    { x: b + tx, y: d + ty },
  ];
}

function effectToApi(effect: Effect): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: effect.type,
    visible: effect.visible,
  };

  if ("radius" in effect) base.radius = effect.radius;
  if ("color" in effect && effect.color) base.color = rgbaToApi(effect.color);
  if ("offset" in effect && effect.offset) base.offset = effect.offset;
  if ("spread" in effect) base.spread = effect.spread;
  if ("blendMode" in effect) base.blendMode = effect.blendMode;

  return base;
}

function constraintsToApi(
  node: SceneNode & { constraints?: Constraints },
): { horizontal: string; vertical: string } | undefined {
  if (!("constraints" in node) || !node.constraints) return undefined;
  return {
    horizontal: node.constraints.horizontal,
    vertical: node.constraints.vertical,
  };
}

function boundingBoxFromNode(
  node: SceneNode,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!("absoluteBoundingBox" in node)) return undefined;
  const bb = (node as FrameNode).absoluteBoundingBox;
  if (!bb) return undefined;
  return { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
}

function renderBoundsFromNode(
  node: SceneNode,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!("absoluteRenderBounds" in node)) return undefined;
  const rb = (node as FrameNode).absoluteRenderBounds;
  if (!rb) return undefined;
  return { x: rb.x, y: rb.y, width: rb.width, height: rb.height };
}

/**
 * Extract the per-node `styles` map (REST API shape: `Record<StyleType, styleId>`)
 * from the plugin API's split `*StyleId` properties. The extractor's named-style
 * resolution depends on this — without it every fill/stroke/text style gets a
 * synthetic varId instead of the design-system style name.
 */
function nodeStylesToApi(node: SceneNode): Record<string, string> | undefined {
  const styles: Record<string, string> = {};
  const candidates: Array<[string, string]> = [
    ["fill", "fillStyleId"],
    ["stroke", "strokeStyleId"],
    ["effect", "effectStyleId"],
    ["text", "textStyleId"],
    ["grid", "gridStyleId"],
  ];
  for (const [key, prop] of candidates) {
    if (!(prop in node)) continue;
    const value = (node as unknown as Record<string, unknown>)[prop];
    if (typeof value === "string" && value.length > 0) {
      styles[key] = value;
    }
  }
  return Object.keys(styles).length > 0 ? styles : undefined;
}

// ── Yielding & cancellation ──────────────────────────────────────────────────

let cancelled = false;

class ExportCancelled extends Error {
  constructor() { super("Export cancelled"); }
}

/**
 * Per-node `await setTimeout(0)` is catastrophic on large trees: browsers
 * clamp `setTimeout(_, 0)` to ~4 ms and to ~10 ms+ after nested calls. A
 * 10k-node export then spends 1–2 minutes inside timer queues alone — which
 * is exactly the "slow / never completes" symptom on large files.
 *
 * Strategy: cancellation flag check is synchronous and free, so we do it
 * every node. We only *actually* yield (a real macrotask via setTimeout 0)
 * every YIELD_INTERVAL nodes, which is enough to keep the UI responsive and
 * let postMessages flush without paying the timer-clamp tax per node.
 */
const YIELD_INTERVAL = 500;
let yieldCounter = 0;

function resetYieldCounter() {
  yieldCounter = 0;
}

function checkCancelled() {
  if (cancelled) throw new ExportCancelled();
}

function maybeYield(): Promise<void> | void {
  checkCancelled();
  if (++yieldCounter < YIELD_INTERVAL) return;
  yieldCounter = 0;
  return new Promise((resolve, reject) => setTimeout(() => {
    if (cancelled) reject(new ExportCancelled());
    else resolve();
  }, 0));
}

// ── Node count ───────────────────────────────────────────────────────────────

function countNodes(node: SceneNode, currentDepth: number, maxDepth?: number): number {
  let count = 1;
  if ("children" in node) {
    if (maxDepth !== undefined && currentDepth >= maxDepth) return count;
    for (const child of (node as FrameNode & { children: readonly SceneNode[] }).children) {
      count += countNodes(child, currentDepth + 1, maxDepth);
    }
  }
  return count;
}

// ── SVG-eligibility detection ────────────────────────────────────────────────

/**
 * Mirrors `SVG_ELIGIBLE_TYPES` in src/extractors/built-in.ts. Kept in sync so
 * the plugin can pre-render SVGs for the same subtrees the extractor will
 * collapse to IMAGE-SVG, ensuring the agent gets actual vector markup instead
 * of a typed placeholder.
 */
const SVG_LEAF_TYPES = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "ELLIPSE",
  "REGULAR_POLYGON",
  "RECTANGLE",
]);

const SVG_CONTAINER_TYPES = new Set(["FRAME", "GROUP", "INSTANCE", "BOOLEAN_OPERATION"]);

// Primitives whose geometry is inherently complex (curves, custom paths,
// multi-vertex shapes). Worth a standalone SVG even when they appear alone.
const SVG_COMPLEX_PRIMITIVES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "REGULAR_POLYGON"]);

// Primitives whose geometry is fully describable by the JSON's size + fills +
// strokes (a lone RECTANGLE / ELLIPSE / LINE is just bbox + paint data). These
// are only worth an SVG when they're part of a multi-primitive composition.
const SVG_SIMPLE_PRIMITIVES = new Set(["LINE", "ELLIPSE", "RECTANGLE"]);

function nodeHasImageFill(node: SceneNode): boolean {
  if (!("fills" in node)) return false;
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return false;
  return fills.some((f) => f.type === "IMAGE");
}

/**
 * Decide whether a candidate "all-vector" subtree is actually worth
 * round-tripping through `exportAsync`. Without this filter, a typical UI
 * design page surfaces 1000+ candidates (every hidden node, every empty
 * rectangle, every 1px separator) of which 10–20 are real icons. The
 * round-trip cost of `exportAsync` on the dead candidates dominates the
 * asset phase.
 *
 * Filter logic, in order of cheapness:
 *   1. Node (or any ancestor) is invisible → skip. `absoluteRenderBounds`
 *      returns null when Figma's renderer would produce nothing for this
 *      subtree, which captures inherited visibility too.
 *   2. Render bounds are zero-area → skip. Includes "width=0" spacers and
 *      fully-clipped nodes.
 *   3. Subtree contains at least one complex vector primitive (path-based
 *      shape) → export. These can't be losslessly described by JSON.
 *   4. Subtree contains ≥2 primitives total → export. A composition of
 *      simple shapes is also worth visual fidelity.
 *   5. Otherwise (single trivial primitive) → skip. The JSON's size + fills
 *      + strokes already describes it perfectly.
 */
function isSvgWorthExporting(node: SceneNode): boolean {
  if (node.visible === false) return false;

  let rb: { x: number; y: number; width: number; height: number } | null = null;
  try {
    if ("absoluteRenderBounds" in node) {
      rb = (node as FrameNode).absoluteRenderBounds;
    }
  } catch {
    rb = null;
  }
  if (!rb || rb.width <= 0 || rb.height <= 0) return false;

  let complexCount = 0;
  let primitiveCount = 0;
  function tally(n: SceneNode) {
    if (n.visible === false) return;
    if (SVG_COMPLEX_PRIMITIVES.has(n.type)) {
      complexCount++;
      primitiveCount++;
      // Short-circuit possible once we know it's worth it; complex primitives
      // always qualify on their own.
      return;
    }
    if (SVG_SIMPLE_PRIMITIVES.has(n.type)) primitiveCount++;
    if ("children" in n) {
      for (const c of (n as FrameNode & { children: readonly SceneNode[] }).children) {
        tally(c);
        if (complexCount > 0) return;
      }
    }
  }
  tally(node);

  return complexCount > 0 || primitiveCount >= 2;
}

/**
 * Walk a subtree once and return the topmost "all-SVG" nodes — nodes
 * whose entire subtree is vector-only and whose parent is NOT also all-SVG.
 * These are the nodes worth rendering as standalone SVG files; rendering
 * inner nodes too would duplicate content.
 *
 * Returns node references (not just IDs) so the caller doesn't have to do a
 * `figma.getNodeByIdAsync()` round-trip per icon — on a page with 200+ icons
 * that single change shaves seconds off the export.
 *
 * Implementation note: this is a single bottom-up traversal. The previous
 * approach called `isAllSvg` at every node, which itself recursed the whole
 * subtree — quadratic blow-up on large mixed-content pages (a non-vector
 * frame with 10k descendants did ~50M extra visits). We now compute the
 * boolean per node in one pass and select roots in a second linear pass.
 */
function collectSvgRoots(node: SceneNode): { roots: SceneNode[]; candidates: number } {
  const allSvg = new Map<string, boolean>();

  function computeAllSvg(n: SceneNode): boolean {
    const cached = allSvg.get(n.id);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (nodeHasImageFill(n)) {
      result = false;
    } else if ("children" in n) {
      const children = (n as FrameNode & { children: readonly SceneNode[] }).children;
      if (children.length === 0) {
        result = false;
      } else if (!SVG_CONTAINER_TYPES.has(n.type) && !SVG_LEAF_TYPES.has(n.type)) {
        result = false;
        // Still need to evaluate descendants — they may contain their own roots.
        for (const c of children) computeAllSvg(c);
      } else {
        let all = true;
        for (const c of children) {
          if (!computeAllSvg(c)) all = false;
        }
        result = all;
      }
    } else if (SVG_LEAF_TYPES.has(n.type)) {
      result = true;
    } else {
      result = false;
    }

    allSvg.set(n.id, result);
    return result;
  }

  const roots: SceneNode[] = [];
  let candidates = 0;
  function selectRoots(n: SceneNode, parentIsAllSvg: boolean) {
    const self = allSvg.get(n.id) === true;
    if (self && !parentIsAllSvg) {
      candidates++;
      // Only materialize this as an export target if it's actually worth
      // sending through exportAsync. Without this filter, every hidden node,
      // empty rect, and 1px separator becomes a round-trip to the renderer.
      if (isSvgWorthExporting(n)) roots.push(n);
    }
    if ("children" in n && !self) {
      for (const child of (n as FrameNode & { children: readonly SceneNode[] }).children) {
        selectRoots(child, false);
      }
    }
  }

  computeAllSvg(node);
  selectRoots(node, false);
  return { roots, candidates };
}

/**
 * Bounded-concurrency parallel map. Figma's `exportAsync` and `getBytesAsync`
 * are fulfilled by the host renderer, which can serve several in-flight
 * requests at once. Running them strictly sequentially leaves throughput on
 * the floor — a 200-icon SVG export went from ~30s sequential to ~5s with
 * concurrency=6. Cap is conservative: too high risks backpressure / OOM in
 * the host process for very large vectors.
 *
 * Cancellation is checked between scheduled items so the user can still bail
 * out mid-batch.
 */
async function parallelMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      checkCancelled();
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ── Node Serializer ──────────────────────────────────────────────────────────

type ProgressTracker = {
  callback: (serialized: number, total: number, nodeName: string) => void;
  serialized: number;
  total: number;
  // Last `nodeName` actually flushed to the UI. Progress callbacks are
  // throttled to keep postMessage off the per-node hot path; this lets us
  // skip redundant posts when neither the percent bucket nor the name moved.
  lastReportedPercent: number;
  lastReportedAt: number;
};

type SerializedNode = Record<string, unknown>;

type SerializeOpts = {
  currentDepth: number;
  maxDepth?: number;
  progress?: ProgressTracker;
  // Image refs (hashes) to fetch bytes for after serialization
  imageRefs: Set<string>;
  // Memoizes `inst.getMainComponentAsync()` by node id. Without this, every
  // INSTANCE pays the async host round-trip twice (here + in
  // collectCrossScopeComponents), which compounds badly on pages with
  // hundreds of instances.
  mainComponentCache: Map<string, ComponentNode | null>;
  // Collects info about every node whose serialization threw. An error in
  // one subtree no longer aborts the whole export — the broken node is
  // replaced with an error stub and its siblings continue. The plugin
  // surfaces the count + summary in the success message so designers know
  // exactly what didn't make it into the export.
  errors: BrokenNodeRecord[];
};

type BrokenNodeRecord = {
  id: string;
  name: string;
  type: string;
  path: string;
  message: string;
};

// ── Broken-component-set diagnostics ─────────────────────────────────────────

/**
 * Pull every byte of context we can from a node that just blew up inside the
 * Figma API. The raw error ("Component set for node has existing errors")
 * tells you nothing about *which* component set, *where* in the tree, or
 * *which* of the related getters are broken. This probes each one in
 * isolation so the warning identifies the offender precisely.
 *
 * Each probe is wrapped individually because they fail independently: e.g.
 * `componentProperties` can throw while `variantProperties` (the legacy API)
 * still works. The combination of which probes throw is itself diagnostic
 * — it tells you whether the issue is property-definition shape, variant
 * combinatorics, or a missing remote component.
 */
function nodeAncestorPath(node: BaseNode): string {
  const parts: string[] = [];
  let cur: BaseNode | null = node;
  // Cap depth — Figma trees are deep but a runaway loop here would hide the
  // real error we're trying to surface.
  let safety = 50;
  while (cur && safety-- > 0) {
    parts.unshift(`${cur.name} [${cur.type}${cur.id ? ` ${cur.id}` : ""}]`);
    try {
      cur = cur.parent;
    } catch {
      cur = null;
    }
  }
  return parts.join(" › ");
}

async function describeBrokenInstance(
  inst: InstanceNode,
  originalError: unknown,
  failedProbe: string,
): Promise<void> {
  const report: Record<string, unknown> = {
    failedProbe,
    nodeId: inst.id,
    nodeName: inst.name,
    nodeType: inst.type,
    path: nodeAncestorPath(inst),
  };

  try {
    const bb = (inst as InstanceNode).absoluteBoundingBox;
    if (bb) report.position = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
  } catch (e) {
    report.positionError = String(e);
  }

  // Legacy variant API — usually still works when the new property API throws,
  // and tells you exactly which variant combination this instance refers to.
  try {
    const variants = (inst as InstanceNode).variantProperties;
    if (variants) report.variantProperties = variants;
  } catch (e) {
    report.variantPropertiesError = String(e);
  }

  // Probe componentProperties separately — if this one is the one that
  // threw, calling it again will throw again, which is fine: we capture it.
  try {
    const props = inst.componentProperties;
    if (props) report.componentPropertiesKeys = Object.keys(props);
  } catch (e) {
    report.componentPropertiesError = e instanceof Error ? e.message : String(e);
  }

  // Probe overrides count — useful signal for "how customized is this instance"
  try {
    const overrides = (inst as InstanceNode).overrides;
    if (overrides) report.overrideCount = overrides.length;
  } catch (e) {
    report.overridesError = String(e);
  }

  // Main component lookup — async, may throw.
  let main: ComponentNode | null = null;
  try {
    main = await inst.getMainComponentAsync();
    if (main) {
      report.mainComponent = {
        id: main.id,
        name: main.name,
        key: main.key,
        remote: main.remote,
      };
      // Component set parent
      try {
        const parent = main.parent;
        if (parent && parent.type === "COMPONENT_SET") {
          const cs = parent as ComponentSetNode;
          const setInfo: Record<string, unknown> = {
            id: cs.id,
            name: cs.name,
            key: cs.key,
            remote: cs.remote,
            path: nodeAncestorPath(cs),
          };
          try {
            // This is the most common throw site — wrap and capture.
            const defs = cs.componentPropertyDefinitions;
            if (defs) setInfo.propertyDefinitionKeys = Object.keys(defs);
          } catch (e) {
            setInfo.componentPropertyDefinitionsError =
              e instanceof Error ? e.message : String(e);
          }
          try {
            setInfo.variantCount = cs.children.length;
          } catch (e) {
            setInfo.variantCountError = String(e);
          }
          report.componentSet = setInfo;
        }
      } catch (e) {
        report.mainComponentParentError = String(e);
      }
    } else {
      report.mainComponent = null;
    }
  } catch (e) {
    report.getMainComponentError = e instanceof Error ? e.message : String(e);
  }

  report.originalError = originalError instanceof Error
    ? { message: originalError.message, stack: originalError.stack }
    : String(originalError);

  warn(`broken instance detected:\n${JSON.stringify(report, null, 2)}`);
}

/**
 * Generic fallback for any node (not just INSTANCE) whose serialization
 * threw something we didn't anticipate. Pulls whatever metadata is safe to
 * read so the designer can locate the offender, then returns a minimal stub
 * that takes the broken node's place in the parent's children array.
 *
 * The stub keeps `id` / `name` / `type` so downstream consumers can still
 * reference it, and adds a `__framelinkError` marker so AI agents can
 * distinguish a real node from one that failed to export.
 */
function describeBrokenNode(node: SceneNode, err: unknown): BrokenNodeRecord {
  const record: BrokenNodeRecord = {
    id: node.id,
    name: node.name,
    type: node.type,
    path: nodeAncestorPath(node),
    message: err instanceof Error ? err.message : String(err),
  };
  const detail: Record<string, unknown> = { ...record };
  try {
    const bb = (node as FrameNode).absoluteBoundingBox;
    if (bb) detail.position = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
  } catch {
    // ignore — we did our best
  }
  if (err instanceof Error && err.stack) detail.stack = err.stack;
  warn(`broken node detected:\n${JSON.stringify(detail, null, 2)}`);
  return record;
}

function makeErrorStub(node: SceneNode, err: unknown): SerializedNode {
  const stub: SerializedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    __framelinkError: err instanceof Error ? err.message : String(err),
  };
  // Best-effort position so layout-aware consumers can still place a
  // placeholder where the broken node lived.
  try {
    const bb = (node as FrameNode).absoluteBoundingBox;
    if (bb) stub.absoluteBoundingBox = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
  } catch {
    // ignore
  }
  try {
    if ("width" in node) {
      stub.size = { x: (node as FrameNode).width, y: (node as FrameNode).height };
    }
  } catch {
    // ignore
  }
  return stub;
}

async function serializeNode(node: SceneNode, opts: SerializeOpts): Promise<SerializedNode> {
  const result: SerializedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  };

  const bb = boundingBoxFromNode(node);
  if (bb) result.absoluteBoundingBox = bb;
  const rb = renderBoundsFromNode(node);
  if (rb) result.absoluteRenderBounds = rb;

  if ("width" in node) result.size = { x: (node as FrameNode).width, y: (node as FrameNode).height };

  const c = constraintsToApi(node as SceneNode & { constraints?: Constraints });
  if (c) result.constraints = c;

  if ("blendMode" in node) result.blendMode = (node as GeometryMixin & BaseNodeMixin).blendMode;
  if ("opacity" in node) result.opacity = (node as BlendMixin).opacity;
  if ("isMask" in node) result.isMask = (node as unknown as { isMask: boolean }).isMask;

  // Per-node named-style references (REST API `styles` object).
  // Extractor's getStyleMatch reads this to resolve fill/text/effect styleIds.
  const nodeStyles = nodeStylesToApi(node);
  if (nodeStyles) result.styles = nodeStyles;

  if ("fills" in node) {
    const fills = node.fills;
    if (fills !== figma.mixed && Array.isArray(fills)) {
      result.fills = fills.map(colorToApi);
      // Track image-fill refs for asset collection
      for (const fill of fills) {
        if (fill.type === "IMAGE" && fill.imageHash) {
          opts.imageRefs.add(fill.imageHash);
        }
      }
    }
  }

  if ("strokes" in node) {
    result.strokes = (node as GeometryMixin).strokes.map(colorToApi);
  }
  if ("strokeWeight" in node) {
    const sw = (node as GeometryMixin).strokeWeight;
    if (sw !== figma.mixed) result.strokeWeight = sw;
  }
  if ("strokeAlign" in node) result.strokeAlign = (node as GeometryMixin).strokeAlign;

  if ("cornerRadius" in node) {
    const cr = (node as RectangleNode).cornerRadius;
    if (cr !== figma.mixed) {
      result.cornerRadius = cr;
    } else if ("topLeftRadius" in node) {
      result.rectangleCornerRadii = [
        (node as RectangleNode).topLeftRadius,
        (node as RectangleNode).topRightRadius,
        (node as RectangleNode).bottomRightRadius,
        (node as RectangleNode).bottomLeftRadius,
      ];
    }
  }

  if ("effects" in node) {
    result.effects = (node as BlendMixin & SceneNode).effects.map(effectToApi);
  }

  if ("clipsContent" in node) result.clipsContent = (node as FrameNode).clipsContent;

  if ("layoutMode" in node) {
    const frame = node as FrameNode;
    if (frame.layoutMode !== "NONE") {
      result.layoutMode = frame.layoutMode;
      result.primaryAxisSizingMode = frame.primaryAxisSizingMode;
      result.counterAxisSizingMode = frame.counterAxisSizingMode;
      result.primaryAxisAlignItems = frame.primaryAxisAlignItems;
      result.counterAxisAlignItems = frame.counterAxisAlignItems;
      result.itemSpacing = frame.itemSpacing;
      result.counterAxisSpacing = frame.counterAxisSpacing ?? 0;
      result.paddingLeft = frame.paddingLeft;
      result.paddingRight = frame.paddingRight;
      result.paddingTop = frame.paddingTop;
      result.paddingBottom = frame.paddingBottom;

      if ("layoutWrap" in frame) {
        result.layoutWrap = frame.layoutWrap;
      }
    }
  }

  if ("layoutSizingHorizontal" in node) {
    result.layoutSizingHorizontal = (node as FrameNode).layoutSizingHorizontal;
  }
  if ("layoutSizingVertical" in node) {
    result.layoutSizingVertical = (node as FrameNode).layoutSizingVertical;
  }
  if ("layoutGrow" in node) result.layoutGrow = (node as FrameNode).layoutGrow;
  if ("layoutAlign" in node) result.layoutAlign = (node as FrameNode).layoutAlign;
  if ("layoutPositioning" in node) result.layoutPositioning = (node as FrameNode).layoutPositioning;

  if ("minWidth" in node) {
    const f = node as FrameNode;
    if (f.minWidth != null) result.minWidth = f.minWidth;
    if (f.maxWidth != null) result.maxWidth = f.maxWidth;
    if (f.minHeight != null) result.minHeight = f.minHeight;
    if (f.maxHeight != null) result.maxHeight = f.maxHeight;
  }

  // ── Text ───────────────────────────────────────────────────────────────────

  if (node.type === "TEXT") {
    const text = node as TextNode;
    result.characters = text.characters;

    const fontSize = text.fontSize !== figma.mixed ? text.fontSize : 14;
    const fontWeight = text.fontWeight !== figma.mixed ? text.fontWeight : 400;
    const fontFamily =
      text.fontName !== figma.mixed ? text.fontName.family : "Inter";
    const fontStyle =
      text.fontName !== figma.mixed ? text.fontName.style : "Regular";
    const letterSpacing =
      text.letterSpacing !== figma.mixed ? text.letterSpacing : { value: 0, unit: "PIXELS" };
    const lineHeight =
      text.lineHeight !== figma.mixed ? text.lineHeight : { unit: "AUTO" };
    const textAlignHorizontal = text.textAlignHorizontal;
    const textAlignVertical = text.textAlignVertical;
    const textDecoration = text.textDecoration !== figma.mixed ? text.textDecoration : "NONE";
    const textCase = text.textCase !== figma.mixed ? text.textCase : "ORIGINAL";

    result.style = {
      fontFamily,
      fontPostScriptName: `${fontFamily}-${fontStyle.replace(/\s+/g, "")}`,
      fontWeight,
      fontSize,
      textAlignHorizontal,
      textAlignVertical,
      letterSpacing: letterSpacing.unit === "PERCENT"
        ? (letterSpacing.value / 100) * (fontSize as number)
        : letterSpacing.value,
      lineHeightPx:
        lineHeight.unit === "PIXELS"
          ? lineHeight.value
          : lineHeight.unit === "PERCENT"
            ? (lineHeight.value / 100) * (fontSize as number)
            : (fontSize as number) * 1.2,
      lineHeightUnit: lineHeight.unit === "AUTO" ? "INTRINSIC_%"
        : lineHeight.unit === "PERCENT" ? "FONT_SIZE_%"
          : "PIXELS",
      textDecoration,
      textCase,
    };

    try {
      const segments = text.getStyledTextSegments([
        "fontSize", "fontWeight", "fontName", "fills",
        "letterSpacing", "lineHeight", "textDecoration", "textCase",
      ]);

      if (segments.length > 1) {
        const overrides: Record<string, Record<string, unknown>> = {};
        const characterStyleOverrides: number[] = [];
        let overrideId = 1;

        for (const seg of segments) {
          const id = overrideId++;
          overrides[String(id)] = {
            fontFamily: seg.fontName.family,
            fontWeight: seg.fontWeight,
            fontSize: seg.fontSize,
            textDecoration: seg.textDecoration,
            textCase: seg.textCase,
            fills: seg.fills.map(colorToApi),
          };
          for (let i = 0; i < seg.end - seg.start; i++) {
            characterStyleOverrides.push(id);
          }
        }

        result.characterStyleOverrides = characterStyleOverrides;
        result.styleOverrideTable = overrides;
      }
    } catch (e) {
      // getStyledTextSegments may fail on some text nodes — non-critical
      warn(`getStyledTextSegments failed for text node ${node.id} (${node.name}):`, e);
    }
  }

  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    const comp = node as ComponentNode | ComponentSetNode;
    // `componentPropertyDefinitions` throws if the component set has invariant
    // errors (broken variants, missing remote library, malformed property
    // definitions). One bad node would otherwise kill the entire export.
    try {
      const defs = comp.componentPropertyDefinitions;
      if (defs) result.componentPropertyDefinitions = defs;
    } catch (e) {
      warn(
        `componentPropertyDefinitions threw on ${node.type} ${node.id} (${node.name}) at ${nodeAncestorPath(node)} — underlying error:`,
        e,
      );
    }
  }

  if (node.type === "INSTANCE") {
    const inst = node as InstanceNode;
    // `componentProperties` throws with "Component set for node has existing
    // errors" if the instance's component set is broken. Defer to the rich
    // diagnostic helper so the warning identifies *which* part is broken.
    try {
      const props = inst.componentProperties;
      if (props) result.componentProperties = props;
    } catch (e) {
      await describeBrokenInstance(inst, e, "componentProperties");
    }
    const cached = opts.mainComponentCache.get(inst.id);
    let mainComp: ComponentNode | null;
    if (cached !== undefined) {
      mainComp = cached;
    } else {
      try {
        mainComp = await inst.getMainComponentAsync();
      } catch (e) {
        await describeBrokenInstance(inst, e, "getMainComponentAsync");
        mainComp = null;
      }
      opts.mainComponentCache.set(inst.id, mainComp);
    }
    if (mainComp) {
      result.componentId = mainComp.id;
    }
  }

  if ("children" in node) {
    const container = node as FrameNode & { children: readonly SceneNode[] };
    if (opts.maxDepth !== undefined && opts.currentDepth >= opts.maxDepth) {
      result.children = [];
    } else {
      const childResults: SerializedNode[] = [];
      for (const child of container.children) {
        try {
          childResults.push(
            await serializeNode(child, { ...opts, currentDepth: opts.currentDepth + 1 }),
          );
        } catch (e) {
          // Cancellation must propagate — it's a user action, not a data bug.
          if (e instanceof ExportCancelled) throw e;
          // Any other throw: log it, record it, drop in an error stub so the
          // parent still has structurally valid children, and keep going so
          // sibling subtrees aren't lost.
          opts.errors.push(describeBrokenNode(child, e));
          childResults.push(makeErrorStub(child, e));
        }
      }
      result.children = childResults;
    }
  }

  if (opts.progress) {
    const p = opts.progress;
    p.serialized++;
    // Throttle: only post when the integer-percent bucket changes OR 100ms
    // has elapsed since the last post. Posting per node turned the UI thread
    // into the bottleneck on big trees (each postMessage = structured-clone
    // across the sandbox boundary).
    const pct = p.total > 0 ? Math.floor((p.serialized / p.total) * 100) : 0;
    const now = Date.now();
    if (
      pct !== p.lastReportedPercent ||
      now - p.lastReportedAt >= 100 ||
      p.serialized === p.total
    ) {
      p.lastReportedPercent = pct;
      p.lastReportedAt = now;
      p.callback(p.serialized, p.total, node.name);
    }
  }

  const pending = maybeYield();
  if (pending) await pending;

  return result;
}

// ── Component & Style collection ─────────────────────────────────────────────

type ComponentMeta = {
  key: string;
  name: string;
  description: string;
  componentSetId?: string;
};

type ComponentSetMeta = {
  key: string;
  name: string;
  description: string;
};

function collectComponents(
  node: SceneNode,
  components: Record<string, ComponentMeta>,
  componentSets: Record<string, ComponentSetMeta>,
) {
  if (node.type === "COMPONENT") {
    const comp = node as ComponentNode;
    const meta: ComponentMeta = {
      key: comp.key,
      name: comp.name,
      description: comp.description,
    };
    if (comp.parent && comp.parent.type === "COMPONENT_SET") {
      meta.componentSetId = comp.parent.id;
    }
    components[comp.id] = meta;
  }

  if (node.type === "COMPONENT_SET") {
    const cs = node as ComponentSetNode;
    componentSets[cs.id] = {
      key: cs.key,
      name: cs.name,
      description: cs.description,
    };
  }

  if ("children" in node) {
    for (const child of (node as FrameNode & { children: readonly SceneNode[] }).children) {
      collectComponents(child, components, componentSets);
    }
  }
}

/**
 * Walk a subtree, find all INSTANCE nodes whose main component lives outside
 * the current export scope, and add the missing component metadata so the
 * extractor's component lookup resolves cleanly. Without this, agents see
 * `componentId: <id>` references with no matching definition.
 *
 * Reads `mainComponentCache` populated during serialization so we don't pay
 * the async `getMainComponentAsync()` round-trip a second time per instance.
 */
async function collectCrossScopeComponents(
  node: SceneNode,
  components: Record<string, ComponentMeta>,
  componentSets: Record<string, ComponentSetMeta>,
  mainComponentCache: Map<string, ComponentNode | null>,
): Promise<void> {
  if (node.type === "INSTANCE") {
    const inst = node as InstanceNode;
    let main: ComponentNode | null | undefined = mainComponentCache.get(inst.id);
    if (main === undefined) {
      try {
        main = await inst.getMainComponentAsync();
      } catch (e) {
        await describeBrokenInstance(inst, e, "collectCrossScopeComponents.getMainComponentAsync");
        main = null;
      }
      mainComponentCache.set(inst.id, main);
    }
    if (main && !components[main.id]) {
      const meta: ComponentMeta = {
        key: main.key,
        name: main.name,
        description: main.description,
      };
      // `main.parent` access can also throw on broken component sets.
      let parent: BaseNode | null = null;
      try {
        parent = main.parent;
      } catch (e) {
        warn(`collectCrossScopeComponents: reading parent threw for component ${main.id} (${main.name}); skipping parent set. Underlying error:`, e);
      }
      if (parent && parent.type === "COMPONENT_SET") {
        meta.componentSetId = parent.id;
        if (!componentSets[parent.id]) {
          const cs = parent as ComponentSetNode;
          componentSets[parent.id] = {
            key: cs.key,
            name: cs.name,
            description: cs.description,
          };
        }
      }
      components[main.id] = meta;
    }
  }
  if ("children" in node) {
    for (const child of (node as FrameNode & { children: readonly SceneNode[] }).children) {
      await collectCrossScopeComponents(child, components, componentSets, mainComponentCache);
    }
  }
}

async function collectStyles(): Promise<Record<string, { key: string; name: string; styleType: string; description: string }>> {
  const styles: Record<string, { key: string; name: string; styleType: string; description: string }> = {};
  for (const style of await figma.getLocalPaintStylesAsync()) {
    styles[style.id] = {
      key: style.key,
      name: style.name,
      styleType: "FILL",
      description: style.description,
    };
  }
  for (const style of await figma.getLocalTextStylesAsync()) {
    styles[style.id] = {
      key: style.key,
      name: style.name,
      styleType: "TEXT",
      description: style.description,
    };
  }
  for (const style of await figma.getLocalEffectStylesAsync()) {
    styles[style.id] = {
      key: style.key,
      name: style.name,
      styleType: "EFFECT",
      description: style.description,
    };
  }
  return styles;
}

// ── Asset collection ─────────────────────────────────────────────────────────

type AssetEntry = {
  /** Path relative to the assets folder, e.g. "node_1_23.png" */
  path: string;
  /** Raw bytes — sent to UI as Uint8Array (structured-cloned through postMessage). */
  bytes: Uint8Array;
  /** MIME type for download blob */
  mime: string;
};

type AssetManifestEntry = {
  /** Relative path to image render of this node (e.g. "design.assets/node_1_23.png"). */
  image?: string;
  imageScale?: number;
  /** Relative path to SVG markup of this node. Set for SVG-eligible vector subtrees. */
  svg?: string;
};

type ImageFillManifest = Record<string, string>; // imageRef → relative path

function safeIdForFilename(id: string): string {
  // Figma node IDs look like "1:23" — colons are illegal on Windows
  return id.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Render a node as PNG @2x. Returns null if the node is empty or rendering
 * fails (Figma will throw for certain node states like fully-transparent
 * groups). Caller treats null as "skip this asset" rather than aborting.
 */
async function exportNodeAsPng(node: SceneNode): Promise<Uint8Array | null> {
  try {
    return await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: FRAME_IMAGE_SCALE },
    });
  } catch (e) {
    warn(`PNG export failed for ${node.id} (${node.name}):`, e);
    return null;
  }
}

async function exportNodeAsSvg(node: SceneNode): Promise<string | null> {
  try {
    return await node.exportAsync({ format: "SVG_STRING" });
  } catch (e) {
    warn(`SVG export failed for ${node.id} (${node.name}):`, e);
    return null;
  }
}

function utf8Encode(s: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
  // Fallback for older Figma sandboxes — naive UTF-8 encoder.
  const bytes = new Uint8Array(s.length * 4);
  let pos = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes[pos++] = c;
    else if (c < 0x800) {
      bytes[pos++] = 0xc0 | (c >> 6);
      bytes[pos++] = 0x80 | (c & 0x3f);
    } else {
      bytes[pos++] = 0xe0 | (c >> 12);
      bytes[pos++] = 0x80 | ((c >> 6) & 0x3f);
      bytes[pos++] = 0x80 | (c & 0x3f);
    }
  }
  return bytes.slice(0, pos);
}

type AssetCollectionResult = {
  assets: AssetEntry[];
  manifest: Record<string, AssetManifestEntry>; // nodeId → entry
  imageFills: ImageFillManifest;
  /** Folder name (without trailing slash) where assets are placed in the ZIP. */
  assetsFolder: string;
};

type AssetOptions = {
  exportFrameImages: boolean;
  exportSvgs: boolean;
  exportImageFills: boolean;
  /** Top-level frames to render as PNG. */
  topLevelNodes: readonly SceneNode[];
  /** Image-fill refs collected during serialization. */
  imageRefs: Set<string>;
  /** Asset folder name (e.g. "design.assets"). */
  assetsFolder: string;
  onProgress: (label: string) => void;
};

async function collectAssets(opts: AssetOptions): Promise<AssetCollectionResult> {
  const assets: AssetEntry[] = [];
  const manifest: Record<string, AssetManifestEntry> = {};
  const imageFills: ImageFillManifest = {};
  const folder = opts.assetsFolder;

  // 1. Top-level frame screenshots — what the agent uses for visual grounding.
  if (opts.exportFrameImages) {
    const phaseStart = now();
    log(`assets/png: rendering ${opts.topLevelNodes.length} top-level node(s)…`);
    opts.onProgress(`Rendering ${opts.topLevelNodes.length} top-level PNG(s)…`);
    let pngOk = 0;
    let pngFail = 0;
    let pngBytes = 0;
    // Top-level frames are heavier than icons; cap concurrency lower so we
    // don't OOM the host on giant @2x renders.
    const results = await parallelMap(opts.topLevelNodes, 3, async (node) => {
      const nodeStart = now();
      const bytes = await exportNodeAsPng(node);
      return { node, bytes, took: ms(nodeStart) };
    });
    for (const { node, bytes, took } of results) {
      if (bytes) {
        pngOk++;
        pngBytes += bytes.length;
        log(`  PNG ok: ${node.name} (${node.id}) — ${(bytes.length / 1024).toFixed(1)} KB in ${took}`);
        const filename = `node_${safeIdForFilename(node.id)}.png`;
        assets.push({ path: filename, bytes, mime: "image/png" });
        manifest[node.id] = {
          ...(manifest[node.id] ?? {}),
          image: `${folder}/${filename}`,
          imageScale: FRAME_IMAGE_SCALE,
        };
      } else {
        pngFail++;
      }
    }
    log(`assets/png: done (${pngOk} ok, ${pngFail} failed, ${(pngBytes / 1024 / 1024).toFixed(2)} MB) in ${ms(phaseStart)}`);
  }

  // 2. SVG exports for vector subtrees — closes the IMAGE-SVG dead-end.
  if (opts.exportSvgs) {
    const phaseStart = now();
    const detectStart = now();
    // Dedupe by node id across multiple top-level nodes (rare for selection,
    // common for page scope where overlapping subtrees can surface the same
    // root twice).
    const seen = new Set<string>();
    const svgNodes: SceneNode[] = [];
    let totalCandidates = 0;
    for (const top of opts.topLevelNodes) {
      const { roots: topRoots, candidates } = collectSvgRoots(top);
      totalCandidates += candidates;
      for (const n of topRoots) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          svgNodes.push(n);
        }
      }
    }
    const filtered = totalCandidates - svgNodes.length;
    log(
      `assets/svg: ${svgNodes.length} worth exporting ` +
      `(filtered out ${filtered} of ${totalCandidates} candidates: invisible / zero-area / single-trivial-primitive) ` +
      `in ${ms(detectStart)}`,
    );
    let svgOk = 0;
    let svgFail = 0;
    let svgBytes = 0;
    let svgDone = 0;
    // SVG export is the long pole on icon-heavy designs. Each call is a
    // round-trip to the host renderer; sequential awaits left ~80% of host
    // throughput unused. concurrency=6 is a sweet spot in measurement —
    // higher values stop helping once the host is saturated and just add
    // memory pressure for the queued promises.
    const results = await parallelMap(svgNodes, 6, async (node) => {
      const nodeStart = now();
      const svg = await exportNodeAsSvg(node);
      svgDone++;
      // Throttled progress: only every ~25 to keep postMessage cheap.
      if (svgDone % 25 === 0 || svgDone === svgNodes.length) {
        opts.onProgress(`Rendering SVG ${svgDone}/${svgNodes.length}…`);
      }
      return { node, svg, took: ms(nodeStart) };
    });
    for (const { node, svg, took } of results) {
      if (svg) {
        svgOk++;
        svgBytes += svg.length;
        // Only log per-icon detail at high verbosity to avoid spamming for
        // hundreds of icons. Slow ones (>200ms) always get logged.
        const tookMs = parseFloat(took);
        if (DEBUG && tookMs > 200) {
          log(`  SVG slow: ${node.name} (${node.id}) — ${svg.length} chars in ${took}`);
        }
        const filename = `icon_${safeIdForFilename(node.id)}.svg`;
        assets.push({ path: filename, bytes: utf8Encode(svg), mime: "image/svg+xml" });
        manifest[node.id] = {
          ...(manifest[node.id] ?? {}),
          svg: `${folder}/${filename}`,
        };
      } else {
        svgFail++;
      }
    }
    log(`assets/svg: done (${svgOk} ok, ${svgFail} failed, ${(svgBytes / 1024 / 1024).toFixed(2)} MB) in ${ms(phaseStart)}`);
  }

  // 3. Image-fill bytes (raster fills referenced by imageRef hash).
  if (opts.exportImageFills) {
    const phaseStart = now();
    log(`assets/imageFills: fetching ${opts.imageRefs.size} image fill(s)…`);
    opts.onProgress(`Fetching ${opts.imageRefs.size} image fill(s)…`);
    let fillOk = 0;
    let fillSkip = 0;
    let fillFail = 0;
    let fillBytes = 0;
    const refs = Array.from(opts.imageRefs);
    type FillResult =
      | { kind: "ok"; ref: string; bytes: Uint8Array }
      | { kind: "skip"; ref: string }
      | { kind: "fail"; ref: string; err: unknown };
    const results = await parallelMap<string, FillResult>(refs, 6, async (ref): Promise<FillResult> => {
      try {
        const image = figma.getImageByHash(ref);
        if (!image) return { kind: "skip", ref };
        const bytes = await image.getBytesAsync();
        return { kind: "ok", ref, bytes };
      } catch (e) {
        return { kind: "fail", ref, err: e };
      }
    });
    for (const r of results) {
      if (r.kind === "ok") {
        fillOk++;
        fillBytes += r.bytes.length;
        const filename = `image_${r.ref}.png`;
        assets.push({ path: filename, bytes: r.bytes, mime: "image/png" });
        imageFills[r.ref] = `${folder}/${filename}`;
      } else if (r.kind === "skip") {
        fillSkip++;
        warn(`assets/imageFills: no image for ref ${r.ref}`);
      } else {
        fillFail++;
        warn(`assets/imageFills: failed to fetch bytes for ref ${r.ref}:`, r.err);
      }
    }
    log(`assets/imageFills: done (${fillOk} ok, ${fillSkip} skipped, ${fillFail} failed, ${(fillBytes / 1024 / 1024).toFixed(2)} MB) in ${ms(phaseStart)}`);
  }

  return { assets, manifest, imageFills, assetsFolder: folder };
}

// ── Export logic ──────────────────────────────────────────────────────────────

function generateDefaultFileName(): string {
  // Returned WITHOUT extension. The UI appends .json or .zip based on whether
  // assets are bundled — surfacing a fixed extension here would mislead users
  // since the plugin downloads as .zip when assets are included.
  const safeName = figma.root.name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  // YYYYMMDD-HHMMSS in local time. Filename-safe (no colons), sortable, and
  // unique across multiple exports in the same minute. Local time matches the
  // user's mental model of "when did I export this?" better than UTC would.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${safeName}_${timestamp}`;
}

function deriveAssetsFolder(jsonFileName: string): string {
  const base = jsonFileName.replace(/\.json$/i, "");
  return `${base}.assets`;
}

type ExportInput = {
  scope: "selection" | "page";
  nodes: readonly SceneNode[];
  page: PageNode;
  depth?: number;
  exportFrameImages: boolean;
  exportSvgs: boolean;
  exportImageFills: boolean;
  jsonFileName: string;
};

type ExportResult = {
  json: string;
  assets: AssetEntry[];
  nodeCount: number;
  assetsFolder: string;
  errors: BrokenNodeRecord[];
};

async function performExport(input: ExportInput): Promise<ExportResult> {
  const { scope, nodes, page, depth, jsonFileName } = input;

  if (scope === "selection" && nodes.length === 0) {
    throw new Error("No nodes selected. Select at least one node in Figma.");
  }

  const exportStart = now();
  log(`=== Export start ===`);
  log(`scope=${scope}, depth=${depth ?? "unlimited"}, rootNodes=${nodes.length}, fileName=${jsonFileName}`);
  log(`options: frameImages=${input.exportFrameImages}, svgs=${input.exportSvgs}, imageFills=${input.exportImageFills}`);

  resetYieldCounter();

  const countStart = now();
  const totalNodes = nodes.reduce((acc, n) => acc + countNodes(n, 0, depth), 0);
  log(`countNodes: ${totalNodes} node(s) to serialize — ${ms(countStart)}`);

  const progress: ProgressTracker = {
    callback: (current, total, nodeName) => {
      figma.ui.postMessage({ type: "export-progress", current, total, nodeName });
    },
    serialized: 0,
    total: totalNodes,
    lastReportedPercent: -1,
    lastReportedAt: 0,
  };

  const components: Record<string, ComponentMeta> = {};
  const componentSets: Record<string, ComponentSetMeta> = {};
  const collectCompStart = now();
  for (const n of nodes) collectComponents(n, components, componentSets);
  log(`collectComponents: ${Object.keys(components).length} component(s), ${Object.keys(componentSets).length} set(s) — ${ms(collectCompStart)}`);

  const stylesStart = now();
  const styles = await collectStyles();
  log(`collectStyles: ${Object.keys(styles).length} style(s) — ${ms(stylesStart)}`);

  // Shared cache: populated by serializeNode and reused by
  // collectCrossScopeComponents so each INSTANCE pays the async
  // getMainComponentAsync() round-trip at most once.
  const mainComponentCache = new Map<string, ComponentNode | null>();

  const imageRefs = new Set<string>();
  const serializeErrors: BrokenNodeRecord[] = [];
  const serializeOpts: SerializeOpts = {
    currentDepth: 0,
    maxDepth: depth,
    progress,
    imageRefs,
    mainComponentCache,
    errors: serializeErrors,
  };

  const serializeStart = now();
  log(`serialize: starting walk over ${totalNodes} node(s)…`);
  const serializedNodes: SerializedNode[] = [];
  for (const node of nodes) {
    try {
      serializedNodes.push(await serializeNode(node, serializeOpts));
    } catch (e) {
      if (e instanceof ExportCancelled) throw e;
      // Even a top-level root failing shouldn't kill the export of the
      // other roots in a multi-selection. Same error-stub strategy as
      // child nodes.
      serializeErrors.push(describeBrokenNode(node, e));
      serializedNodes.push(makeErrorStub(node, e));
    }
  }
  log(
    `serialize: done in ${ms(serializeStart)} ` +
    `(${imageRefs.size} image-fill ref(s), ${mainComponentCache.size} instance(s) cached, ` +
    `${serializeErrors.length} node(s) failed to serialize)`,
  );
  if (serializeErrors.length > 0) {
    warn(`serialize: ${serializeErrors.length} node(s) replaced with error stubs. Summary:`);
    for (const r of serializeErrors) {
      warn(`  - ${r.type} ${r.id} (${r.name}) at ${r.path} — ${r.message}`);
    }
  }

  const crossScopeStart = now();
  const beforeCount = Object.keys(components).length;
  for (const n of nodes) {
    await collectCrossScopeComponents(n, components, componentSets, mainComponentCache);
  }
  const added = Object.keys(components).length - beforeCount;
  log(`collectCrossScopeComponents: +${added} external component(s) — ${ms(crossScopeStart)}`);

  const assetsFolder = deriveAssetsFolder(jsonFileName);
  const assetsStart = now();
  const assetResult = await collectAssets({
    exportFrameImages: input.exportFrameImages,
    exportSvgs: input.exportSvgs,
    exportImageFills: input.exportImageFills,
    topLevelNodes: nodes,
    imageRefs,
    assetsFolder,
    onProgress: (label) => {
      figma.ui.postMessage({ type: "export-progress-asset", label });
    },
  });
  const totalAssetBytes = assetResult.assets.reduce((acc, a) => acc + a.bytes.length, 0);
  log(`collectAssets: ${assetResult.assets.length} asset(s), ${(totalAssetBytes / 1024 / 1024).toFixed(2)} MB total — ${ms(assetsStart)}`);

  // Build framelinkExport metadata block — single source of truth for asset
  // resolution on the MCP side. Lives at the JSON root.
  const framelinkExport = {
    pluginVersion: PLUGIN_VERSION,
    exportedAt: new Date().toISOString(),
    scope,
    depth: depth ?? null,
    fileName: figma.root.name,
    pageId: page.id,
    pageName: page.name,
    rootNodeIds: nodes.map((n) => n.id),
    assetsFolder,
    assets: assetResult.manifest,
    imageFills: assetResult.imageFills,
    options: {
      exportFrameImages: input.exportFrameImages,
      exportSvgs: input.exportSvgs,
      exportImageFills: input.exportImageFills,
    },
    // Nodes that threw during serialization — replaced with error stubs in
    // the tree, but enumerated here so downstream consumers can flag them
    // (e.g. an MCP tool could refuse to generate code for these or surface
    // a warning to the user).
    errors: serializeErrors,
  };

  let response: Record<string, unknown>;
  if (scope === "selection") {
    const nodesMap: Record<string, unknown> = {};
    for (let i = 0; i < nodes.length; i++) {
      nodesMap[nodes[i].id] = {
        document: serializedNodes[i],
        components,
        componentSets,
        styles,
      };
    }
    response = {
      name: figma.root.name,
      framelinkExport,
      nodes: nodesMap,
    };
  } else {
    response = {
      name: figma.root.name,
      framelinkExport,
      document: {
        id: "0:0",
        name: "Document",
        type: "DOCUMENT",
        children: [
          {
            id: page.id,
            name: page.name,
            type: "CANVAS",
            children: serializedNodes,
            backgroundColor: page.backgrounds?.[0]
              ? rgbaToApi((page.backgrounds[0] as SolidPaint).color)
              : { r: 1, g: 1, b: 1, a: 1 },
          },
        ],
      },
      components,
      componentSets,
      styles,
    };
  }

  const stringifyStart = now();
  const jsonString = JSON.stringify(response, null, 2);
  log(`JSON.stringify: ${(jsonString.length / 1024 / 1024).toFixed(2)} MB — ${ms(stringifyStart)}`);
  log(`=== Export complete in ${ms(exportStart)} (${serializeErrors.length} broken node(s) skipped) ===`);
  return {
    json: jsonString,
    assets: assetResult.assets,
    nodeCount: nodes.length,
    assetsFolder,
    errors: serializeErrors,
  };
}

// ── Plugin entry point ───────────────────────────────────────────────────────

// Initial height pre-allocates room for the always-reserved progress slot
// (visibility: hidden in CSS) so the loading state never causes a scroll flash
// before the resize message round-trips. Export & Cancel share a single grid
// cell, so we don't need extra room for the cancel button. The UI's
// MutationObserver shrinks this back down once it measures actual content.
figma.showUI(__html__, { width: 380, height: 680 });

function updateSelection() {
  const nodes = figma.currentPage.selection;
  figma.ui.postMessage({
    type: "selection-changed",
    count: nodes.length,
    names: nodes.map((n) => n.name),
    defaultFileName: generateDefaultFileName(),
  });
}

updateSelection();
figma.on("selectionchange", updateSelection);

type UIMessage = {
  type: string;
  scope?: "selection" | "page";
  depth?: number;
  fileName?: string;
  exportFrameImages?: boolean;
  exportSvgs?: boolean;
  exportImageFills?: boolean;
  // For "download-complete" — short summary the toast will display.
  notify?: string;
  // For "open-url" — the URL to open in the user's default browser.
  url?: string;
  // For "resize" — pixel height the UI needs to render without scroll.
  height?: number;
};

// External URLs the plugin is allowed to open. We don't accept arbitrary URLs
// from the UI side (even though the UI is our own code) — this guard documents
// intent and prevents accidental drift if someone adds new buttons later.
const ALLOWED_OPEN_URL_PREFIXES = [
  "https://github.com/MiHarsh/figma-local-mcp",
  "https://www.npmjs.com/package/figma-local-mcp",
];

figma.ui.onmessage = async (msg: UIMessage) => {
  if (msg.type === "cancel-export") {
    log("cancel-export received from UI");
    cancelled = true;
    return;
  }

  // The UI measures its rendered height (DOM-driven, varies with status text /
  // progress visibility) and asks the sandbox to size the window to fit. Hard-
  // coding a height in showUI() left dead whitespace at the bottom.
  if (msg.type === "resize" && typeof msg.height === "number") {
    const clamped = Math.max(360, Math.min(900, Math.round(msg.height)));
    figma.ui.resize(380, clamped);
    return;
  }

  // The UI confirms the file download landed in the user's downloads folder.
  // Keeping the dialog open after success was friction; closing here with a
  // canvas toast is the Figma-native UX (matches built-in plugins).
  if (msg.type === "download-complete") {
    if (msg.notify) figma.notify(msg.notify, { timeout: 4000 });
    figma.closePlugin();
    return;
  }

  // Open external links in the user's default browser. The Figma iframe is
  // sandboxed so <a target="_blank"> clicks are blocked — the host API is the
  // only reliable way out.
  if (msg.type === "open-url" && msg.url) {
    if (ALLOWED_OPEN_URL_PREFIXES.some((p) => msg.url!.startsWith(p))) {
      figma.openExternal(msg.url);
    }
    return;
  }

  if (msg.type !== "export") return;

  cancelled = false;

  try {
    const scope: "selection" | "page" = msg.scope === "page" ? "page" : "selection";
    const nodes =
      scope === "page"
        ? (figma.currentPage.children as readonly SceneNode[])
        : figma.currentPage.selection;

    const fileName = msg.fileName || generateDefaultFileName();
    const result = await performExport({
      scope,
      nodes,
      page: figma.currentPage,
      depth: msg.depth,
      exportFrameImages: msg.exportFrameImages !== false,
      exportSvgs: msg.exportSvgs !== false,
      exportImageFills: msg.exportImageFills !== false,
      jsonFileName: fileName,
    });

    figma.ui.postMessage({
      type: "export-result",
      success: true,
      json: result.json,
      assets: result.assets.map((a) => ({ path: a.path, bytes: a.bytes, mime: a.mime })),
      assetsFolder: result.assetsFolder,
      fileName,
      nodeCount: result.nodeCount,
      // UI surfaces these as a sub-warning on the success toast so the user
      // knows part of the export was best-effort and can audit the JSON's
      // `framelinkExport.errors` block for details.
      errorCount: result.errors.length,
      errorSummaries: result.errors.slice(0, 5).map((e) => `${e.type} ${e.id} (${e.name})`),
    });
    log(`posted export-result to UI (${result.assets.length} asset(s), json ${(result.json.length / 1024 / 1024).toFixed(2)} MB, ${result.errors.length} skipped node(s))`);
  } catch (err) {
    if (err instanceof ExportCancelled) {
      log("export was cancelled");
      figma.ui.postMessage({ type: "export-cancelled" });
      return;
    }
    error("export failed:", err, err instanceof Error ? err.stack : undefined);
    figma.ui.postMessage({
      type: "export-result",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
