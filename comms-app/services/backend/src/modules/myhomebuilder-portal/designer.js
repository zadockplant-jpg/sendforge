// The live material designer, for every project: its page (the website's static app, served once
// the session is checked) and its renders API. The admin loads a render from the CAD program into
// a project and confirms its surfaces in the designer; the project's client opens it and tries
// finishes. Renders live in mhb_renders (20261011_myhomebuilder_portal_renders.js): the render
// PNG, its surface map PNG (which surface each pixel is) and a small package with the camera and
// each surface's category and plane. handler.js passes `kit`, its response helpers.
import { randomId, readBoundedMultipart, responseHeaders } from "./security.js";
import { getClient, getFile, putFile } from "./store.js";
import { record } from "./books.js";

export const DESIGNER_PATH = "/clients/designer";
const MUSKEGON = "muskegon-addition";
const MAX_RENDER_BYTES = 12 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 4096;
const QUERY_TIMEOUT_MS = 15000;
const ROOMS = new Set(["kitchen", "bathroom", "other"]);
const CATEGORIES = new Set(["floor", "wall", "ceiling", "cabinet", "countertop", "backsplash", "vanity", "vanity-top", "shower-walls", "shower-base", "door", "appliance", "keep"]);
const ORIENTATIONS = new Set(["level", "along-d1", "along-d2", "free"]);

// ---------- Records ----------

function data(row) {
  if (!row) return null;
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
}

export async function listRenders(store, slug) {
  const rows = await store.db("mhb_renders").where({ client_slug: slug }).orderBy("created_at").select("data").timeout(QUERY_TIMEOUT_MS);
  return rows.map(data);
}

export async function getRender(store, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,32}$/u.test(id)) return null;
  return data(await store.db("mhb_renders").where({ id }).first().timeout(QUERY_TIMEOUT_MS));
}

async function putRender(store, render) {
  await store.db("mhb_renders")
    .insert({ id: render.id, client_slug: render.clientSlug, data: JSON.stringify(render), created_at: render.createdAt })
    .onConflict("id")
    .merge({ data: JSON.stringify(render), updated_at: store.db.fn.now() })
    .timeout(QUERY_TIMEOUT_MS);
}

async function deleteRender(store, render) {
  await store.db.transaction(async (trx) => {
    await trx("mhb_renders").where({ id: render.id }).del().timeout(QUERY_TIMEOUT_MS);
    await trx("mhb_files").whereIn("key", [render.image?.key, render.labels?.key].filter(Boolean)).del().timeout(QUERY_TIMEOUT_MS);
  });
}

// ---------- Checking what the designer sends ----------

/** Width and height of a PNG, or null when the bytes are not a PNG. */
export function pngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const vector = (value) => Array.isArray(value) && value.length === 3 && value.every(finiteNumber);

/** The package, checked against the render's size and the categories the designer knows. */
export function readPackage(text, width, height) {
  if (typeof text !== "string" || text.length > MAX_PACKAGE_BYTES) return null;
  let pack;
  try {
    pack = JSON.parse(text);
  } catch {
    return null;
  }
  if (!pack || pack.version !== 1 || pack.width !== width || pack.height !== height || !ROOMS.has(pack.room)) return null;
  const name = typeof pack.name === "string" ? pack.name.trim().replaceAll(/\s+/gu, " ").slice(0, 60) : "";
  const camera = pack.camera;
  if (!name || !camera || !["focal", "cx", "cy"].every((key) => finiteNumber(camera[key])) || !vector(camera.up) || !vector(camera.d1) || !vector(camera.d2)) return null;
  if (!finiteNumber(pack.metersPerUnit) || pack.metersPerUnit < 0.5 || pack.metersPerUnit > 4) return null;
  if (!Array.isArray(pack.regions) || pack.regions.length > 20000) return null;
  const regions = [];
  for (const region of pack.regions) {
    if (!region || !CATEGORIES.has(region.category) || !ORIENTATIONS.has(region.orientation)) return null;
    if (region.normal !== null && !vector(region.normal)) return null;
    if (region.offset !== null && !finiteNumber(region.offset)) return null;
    if (region.axes !== null && !(Array.isArray(region.axes) && region.axes.length === 2 && region.axes.every(vector))) return null;
    regions.push({ category: region.category, orientation: region.orientation, normal: region.normal, offset: region.offset, axes: region.axes });
  }
  return {
    version: 1, name, room: pack.room, width, height, metersPerUnit: pack.metersPerUnit, regions,
    camera: { width: camera.width ?? width, height: camera.height ?? height, focal: camera.focal, cx: camera.cx, cy: camera.cy, up: camera.up, d1: camera.d1, d2: camera.d2, source: String(camera.source || "assumed").slice(0, 20) }
  };
}

async function readPng(file) {
  if (!file || typeof file.arrayBuffer !== "function" || !file.size || file.size > MAX_RENDER_BYTES) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = pngSize(bytes);
  if (!size || size.width < 16 || size.height < 16 || size.width > MAX_SIDE || size.height > MAX_SIDE) return null;
  return { bytes, ...size };
}

// ---------- Responses ----------

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders("application/json; charset=utf-8") });
}

/**
 * Lets the website serve one of the designer's static files. Its policy also allows WebAssembly
 * (the surface model runs in it) and images made in the page.
 */
function designerAssetGrant(assetPath) {
  const headers = responseHeaders("text/html; charset=utf-8");
  headers.delete("Content-Type");
  headers.set("X-MHB-Asset", assetPath);
  headers.set("Content-Security-Policy",
    "default-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
  return new Response(null, { status: 200, headers });
}

function entryOf(render, query) {
  const base = `${DESIGNER_PATH}/api/renders/${encodeURIComponent(render.id)}`;
  return { id: render.id, name: render.package.name, room: render.package.room, image: `${base}/image${query}`, labels: `${base}/labels${query}`, package: render.package };
}

// ---------- Routes ----------

/**
 * Everything under /clients/designer. `who`: { client, authenticated, admin }. The page opens for
 * a signed-in client (their project) or the admin (?project=slug, or the client project they are
 * also signed in to); only the admin adds, changes or deletes renders.
 */
export async function handleDesigner(context, store, pathname, url, who) {
  const { kit } = context;
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";
  const api = pathname === `${DESIGNER_PATH}/api` || pathname.startsWith(`${DESIGNER_PATH}/api/`);
  const { client, authenticated, admin } = who;

  // The project: the admin's choice, or the client's own.
  const wanted = admin ? String(url.searchParams.get("project") || "") : "";
  const project = wanted ? await getClient(store, wanted) : authenticated ? client : null;
  const query = admin && project ? `?project=${encodeURIComponent(project.slug)}` : "";

  if (!api) {
    if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    // Signed out: sign in, then back to the designer (a shared design link keeps its design).
    if (!admin && !authenticated) return kit.redirectResponse(kit.loginLocation(`${DESIGNER_PATH}/${url.search}`));
    // The app's files are relative to its folder, so its address keeps the trailing slash.
    if (pathname === DESIGNER_PATH && !url.pathname.endsWith("/")) return kit.redirectResponse(`${DESIGNER_PATH}/${url.search}`);
    return designerAssetGrant(pathname === DESIGNER_PATH ? `${DESIGNER_PATH}/` : url.pathname);
  }

  if (!admin && !authenticated) return json({ error: "Sign in to the client portal first." }, 401);
  if (!project) return json({ error: "Open the designer from a project." }, 404);

  if (pathname === `${DESIGNER_PATH}/api/scenes`) {
    if (!isRead) return json({ error: "Not allowed." }, 405);
    const renders = await listRenders(store, project.slug);
    return json({ admin: Boolean(admin), project: { slug: project.slug, name: project.name }, builtins: project.slug === MUSKEGON, renders: renders.map((render) => entryOf(render, query)) });
  }

  const match = pathname.match(/^\/clients\/designer\/api\/renders(?:\/([A-Za-z0-9_-]{8,32}))?(?:\/(image|labels|delete))?$/u);
  if (!match) return json({ error: "Not found." }, 404);
  const [, id, part] = match;
  const render = id ? await getRender(store, id) : null;
  if (id && (!render || render.clientSlug !== project.slug)) return json({ error: "Not found." }, 404);

  if (render && (part === "image" || part === "labels")) {
    if (!isRead) return json({ error: "Not allowed." }, 405);
    const file = render[part];
    const object = file?.key ? await getFile(store, file.key) : null;
    if (!object) return json({ error: "Not found." }, 404);
    const headers = responseHeaders("image/png");
    headers.set("Cache-Control", "private, max-age=3600");
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  }

  if (method !== "POST") return json({ error: "Not allowed." }, 405);
  if (!admin) return json({ error: "Only My Home Builder can change renders." }, 403);
  const ip = kit.requestIp(context.request);

  if (render && part === "delete") {
    await deleteRender(store, render);
    await record(store, { actor: "admin", ip, action: "render.deleted", clientSlug: project.slug, summary: `Deleted the designer render ${render.package.name} from ${project.name}` });
    return json({ ok: true });
  }
  if (part) return json({ error: "Not found." }, 404);

  // Add a render, or save a render's reviewed surfaces again.
  const form = await readBoundedMultipart(context.request, MAX_RENDER_BYTES * 2 + MAX_PACKAGE_BYTES + 8192);
  const image = form ? await readPng(form.get("image")) : null;
  const labels = form ? await readPng(form.get("labels")) : null;
  if (!image || !labels || labels.width !== image.width || labels.height !== image.height) return json({ error: "The render and its surface map must be PNG images of the same size." }, 400);
  const pack = readPackage(String(form.get("package") || ""), image.width, image.height);
  if (!pack) return json({ error: "The render's surfaces could not be read." }, 400);
  const renderId = render ? render.id : randomId(12);
  const now = new Date().toISOString();
  const imageFile = { key: `renders/${project.slug}/${renderId}/render.png`, type: "image/png", size: image.bytes.byteLength };
  const labelsFile = { key: `renders/${project.slug}/${renderId}/surfaces.png`, type: "image/png", size: labels.bytes.byteLength };
  await putFile(store, imageFile.key, image.bytes, "image/png");
  await putFile(store, labelsFile.key, labels.bytes, "image/png");
  await putRender(store, { id: renderId, clientSlug: project.slug, package: pack, image: imageFile, labels: labelsFile, createdAt: render?.createdAt ?? now, updatedAt: now });
  const labeled = new Set(pack.regions.map((region) => region.category).filter((category) => category !== "keep")).size;
  await record(store, {
    actor: "admin", ip, action: render ? "render.saved" : "render.added", clientSlug: project.slug,
    summary: `${render ? "Saved the surfaces of" : "Added"} the designer render ${pack.name} ${render ? "for" : "to"} ${project.name} (${labeled} finish group${labeled === 1 ? "" : "s"})`
  });
  return json({ id: renderId }, render ? 200 : 201);
}

/** Whether a project has renders (its client portal then links to the designer). */
export async function hasRenders(store, slug) {
  return Boolean(await store.db("mhb_renders").where({ client_slug: slug }).first("id").timeout(QUERY_TIMEOUT_MS));
}
