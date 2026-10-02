// The crew portal (/clients/crew) and the admin Labor pages (/clients/admin/labor).
//
// Employees and subcontractors sign in with their email and a password they choose from an
// emailed link. Employees send hours; subcontractors send invoices, each with Michigan's
// conditional lien waiver (partial, or full on the final invoice for a job). Both fill out and
// sign their paperwork here (paperwork answers and signed forms are encrypted, secure.js). The
// admin approves work to a job (the books carry it as that job's cost), returns it with a note,
// and marks it paid.
//
// handler.js passes `kit`: its response helpers and document functions.
import { randomId, hashPassword, verifyPassword, readBoundedForm, readBoundedMultipart } from "./security.js";
import { getClient, getDocument, getFile, getPhoto, listClients, listDocuments, listWorkerPhotos, putFile } from "./store.js";
import { adminEmail, clientSender, crewBillMessage, crewLinkMessage, isValidEmail, sendEmail } from "./email.js";
import { MAX_TOTAL_CENTS, addDays, isValidDate, moneyInput, parseMoney, todayInMichigan } from "./billing.js";
import { money } from "./format.js";
import { record } from "./books.js";
import { unfileLaborPayment } from "./bank.js";
import { signPage } from "./pages.js";
import { FORMS, PAPERWORK, fillOfficialForm, readAnswers, typesetDeposit } from "./forms.js";
import { WAIVERS, typesetWaiver } from "./waivers.js";
import { TEAM_NOTICES, addNote, changeNote, upcomingFor } from "./team.js";
import { listNotes } from "./notes.js";
import { getSecure, getSecureJson, putSecure, putSecureJson, secureReady } from "./secure.js";
import {
  CREW_SECTIONS,
  INVITE_TTL_SECONDS,
  LABOR_PAYMENT_METHODS,
  RESET_TTL_SECONDS,
  WORKER_KINDS,
  createCrewSession,
  crewSlug,
  expiredCrewSession,
  findWorkerByEmail,
  getEmployer,
  getLabor,
  getWorker,
  hoursText,
  laborLabel,
  linkToken,
  listLabor,
  listWorkers,
  parseHours,
  putLabor,
  putSetting,
  putWorker,
  readCrewSession
} from "./labor.js";
import {
  adminLaborPage,
  adminWorkerPage,
  crewHomePage,
  crewLinkExpiredPage,
  crewLoginPage,
  crewPasswordPage,
  laborPayPage,
  paperworkFormPage,
  waiverPage
} from "./labor-pages.js";

const MAX_FORM_BYTES = 8192;
const MAX_SIGN_FORM_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/u;
const ID = "([A-Za-z0-9_-]{8,32})";
const BILL_FILE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);

const CREW_NOTICES = {
  "password-set": { text: "Your password is saved and you're signed in." },
  "hours-sent": { text: "Hours sent to My Home Builder." },
  "bill-sent": { text: "Invoice and lien waiver sent to My Home Builder." },
  "bill-sent-shop": { text: "Invoice sent to My Home Builder." },
  "form-signed": { text: "Signed and saved. You can download a copy under Your paperwork." },
  uploaded: { text: "Uploaded and shared with My Home Builder." },
  signed: { text: "Your signature was applied. A signed copy is now on file." },
  "upload-failed": { text: "That file could not be uploaded. Use a PDF or photo under 20 MB.", tone: "error" },
  "photos-added": { text: "Photos added." },
  "photos-invalid": { text: "Choose JPEG, PNG, WebP or GIF photos up to 20 MB each, with a note under 500 characters.", tone: "error" },
  "photo-job-invalid": { text: "Choose the job the photos are from.", tone: "error" },
  "not-open": { text: "That is no longer waiting for you.", tone: "info" },
  "note-added": TEAM_NOTICES["note-added"],
  "note-updated": TEAM_NOTICES["note-updated"],
  "note-invalid": TEAM_NOTICES["note-invalid"],
  invalid: { text: "Please check the form and try again.", tone: "error" }
};

const LABOR_NOTICES = {
  "worker-added": { text: "Added. Their invite to the crew portal was emailed." },
  "worker-added-no-invite": { text: "Added, but the invite did not go out. Use Send the invite again on their page.", tone: "error" },
  "invite-sent": { text: "Link emailed." },
  "invite-failed": { text: "The email did not go out. Check the address and try again.", tone: "error" },
  "profile-saved": { text: "Profile saved." },
  deactivated: { text: "Deactivated. They are signed out and cannot sign in." },
  reactivated: { text: "Reactivated. They can sign in again." },
  "new-hire-reported": { text: "Marked reported." },
  "employer-saved": { text: "Employer details saved." },
  approved: { text: "Approved. It's now a cost on that job in the books." },
  unapproved: { text: "Approval undone. It is waiting for approval again." },
  returned: { text: "Returned. They see your note in the crew portal." },
  "labor-paid": { text: "Marked paid." },
  "labor-unpaid": { text: "Marked unpaid. It is owed again." },
  "section2-signed": { text: "Section 2 signed. The I-9 is complete." },
  "document-shared": { text: "Document shared in their crew portal." },
  signed: { text: "Your signature was applied. A signed copy is now on file." },
  "amount-required": { text: "Enter what the hours cost.", tone: "error" },
  "job-invalid": { text: "Choose one of the client portals, or Shop or not on a job.", tone: "error" },
  "payment-other-required": { text: "Type the payment method when you choose Other.", tone: "error" },
  "payment-date-invalid": { text: "Enter the date it was paid.", tone: "error" },
  "not-waiting": { text: "That was already handled.", tone: "info" },
  "upload-failed": { text: "That file could not be uploaded. Use a PDF, image or office document under 20 MB.", tone: "error" },
  "files-not-configured": { text: "File storage is not configured, so documents cannot be stored yet.", tone: "error" },
  invalid: { text: "Please check the form and try again.", tone: "error" }
};

function noticeFrom(url, notices) {
  const found = notices[url.searchParams.get("notice")];
  return found || null;
}

const errorNotice = (text) => ({ text, tone: "error" });

function clean(value, max) {
  const text = String(value ?? "").trim().replaceAll(/\s+/gu, " ");
  return text.length <= max ? text : null;
}

async function activeClients(store) {
  return (await listClients(store)).filter((client) => client.active !== false);
}

function jobNameOf(clients, slug) {
  if (!slug) return "Shop or not on a job";
  const client = clients.find((entry) => entry.slug === slug);
  return client ? client.label || client.name : slug;
}

// A job picked from a form: "" (shop), or one of the client portals.
function readJob(value, clients) {
  const slug = String(value || "");
  if (!slug) return { slug: "" };
  return clients.some((client) => client.slug === slug) ? { slug } : { error: true };
}

function auditLine(name, ip, at = new Date()) {
  const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Detroit", dateStyle: "medium", timeStyle: "short" }).format(at);
  return `Signed electronically by ${name} on ${when} (Michigan time)${ip ? ` from ${ip}` : ""} in the My Home Builder crew portal.`;
}

function bytesResponse(kit, bytes, name, contentType = "application/pdf") {
  return kit.fileResponse({ body: bytes, size: bytes.byteLength }, name, contentType);
}

function pdfName(worker, spec) {
  return `${spec.title} - ${worker.name}.pdf`.replaceAll(/[\\/:*?"<>|]/gu, "_");
}

// ---------- Invites and password links ----------

async function sendLink(env, store, worker, origin, { reset }) {
  const token = randomId(32);
  const ttl = reset ? RESET_TTL_SECONDS : INVITE_TTL_SECONDS;
  const updated = {
    ...worker,
    invite: { hash: await linkToken(token), kind: reset ? "reset" : "invite", expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), sentAt: new Date().toISOString() }
  };
  await putWorker(store, updated);
  const message = crewLinkMessage({ worker: updated, link: `${origin}/clients/crew/welcome/${token}`, reset });
  const delivery = await sendEmail(env, { to: worker.email, ...message, ...clientSender(env), category: "crew-link" });
  return { ok: delivery.ok, worker: updated };
}

async function workerForToken(store, token) {
  if (!TOKEN_PATTERN.test(token)) return null;
  const hash = await linkToken(token);
  const now = Date.now();
  return (await listWorkers(store)).find((worker) => worker.active !== false && worker.invite?.hash === hash && Date.parse(worker.invite.expiresAt) > now) || null;
}

// ---------- Paperwork ----------

const SECRET_TYPES = new Set(["ssn", "ein", "account", "routing"]);
const SECRET_FIELDS = new Set(["tin"]);

function formKeys(worker) {
  return PAPERWORK[worker.kind] || [];
}

// What a form starts with: the last answers given (without tax id or bank numbers), or the
// profile's name, email and phone.
async function startingValues(store, env, worker, key) {
  const spec = FORMS[key];
  const saved = worker.paperwork?.[key] ? await getSecureJson(store, env, `crew/${worker.id}/${key}.json`).catch(() => null) : null;
  const values = {};
  for (const group of spec.sections) {
    for (const field of group.fields) {
      if (SECRET_TYPES.has(field.type) || SECRET_FIELDS.has(field.name)) continue;
      const value = saved?.values?.[field.name];
      if (value === undefined || value === null || value === "") continue;
      values[field.name] = field.type === "money" ? moneyInput(value) : field.type === "check" ? (value ? "yes" : "") : String(value);
    }
  }
  if (!saved) {
    const [first, ...rest] = String(worker.name || "").trim().split(/\s+/u);
    if (["w4", "i9"].includes(key)) Object.assign(values, { firstName: first || "", lastName: rest.join(" ") });
    if (["miw4", "deposit", "w9"].includes(key)) values.name = worker.name;
    if (key === "miw4" && worker.startDate) Object.assign(values, { newEmployee: "yes", hireDate: worker.startDate });
    if (key === "w9" && worker.company) values.businessName = worker.company;
    if (key === "i9") Object.assign(values, { email: worker.email, phone: worker.phone || "" });
  }
  return values;
}

function readSigner(form, request, kit) {
  const name = clean(form.get("name"), 120);
  if (!name || form.get("consent") !== "yes") return { error: "Enter your full legal name and agree to sign electronically." };
  return { signer: { name, image: kit.decodeSignatureImage(form.get("signature")), signedOn: todayInMichigan(), signedAt: new Date().toISOString(), ip: kit.requestIp(request) } };
}

async function signForm(store, env, worker, key, values, signer) {
  const employer = await getEmployer(store);
  const bytes = key === "deposit"
    ? await typesetDeposit(values, { signer, employer })
    : await fillOfficialForm(key, values, { employer, worker, signer });
  const base = `crew/${worker.id}/${key}`;
  await putSecure(store, env, `${base}.pdf`, bytes);
  if (signer.image) await putSecure(store, env, `${base}-signature.png`, signer.image);
  await putSecureJson(store, env, `${base}.json`, {
    values,
    signer: { name: signer.name, signedOn: signer.signedOn, signedAt: signer.signedAt, ip: signer.ip, image: Boolean(signer.image) }
  });
  const entry = { signedAt: signer.signedAt, signedOn: signer.signedOn, name: signer.name, ...(key === "i9" ? { status: "section1" } : {}) };
  const updated = { ...worker, paperwork: { ...(worker.paperwork || {}), [key]: entry } };
  await putWorker(store, updated);
  return updated;
}

async function paperworkPdf(store, env, worker, key, kit) {
  if (!worker.paperwork?.[key]) return null;
  const bytes = await getSecure(store, env, `crew/${worker.id}/${key}.pdf`);
  return bytes ? bytesResponse(kit, bytes, pdfName(worker, FORMS[key])) : null;
}

// ---------- The crew portal ----------

async function crewHome(context, store, worker, { status = null, code = 200 } = {}) {
  const { kit, env } = context;
  // Everyone sees their upcoming schedule; team leaders also see Important notes.
  // Their photos name their jobs, including any job no longer active.
  const [entries, allClients, documents, schedule, notes, photos] = await Promise.all([
    listLabor(store, { workerId: worker.id, limit: 100 }),
    listClients(store),
    listDocuments(store, crewSlug(worker.id)),
    upcomingFor(store, worker.id),
    worker.teamLeader ? listNotes(store) : null,
    listWorkerPhotos(store, worker.id)
  ]);
  const clients = allClients.filter((client) => client.active !== false);
  return kit.htmlResponse(crewHomePage({ worker, entries, clients, documents, schedule, notes, photos, jobNames: allClients, today: todayInMichigan(), secureReady: secureReady(env), status }), code);
}

async function signedInWorker(context, store) {
  const session = await readCrewSession(context.request, context.env.CLIENT_PORTAL_SESSION_SECRET);
  if (!session) return null;
  const worker = await getWorker(store, session.workerId);
  if (!worker || worker.active === false || (worker.sessionVersion || 1) !== session.version || !worker.passwordHash) return null;
  return worker;
}

function readWorkDate(value, today) {
  const date = String(value || "");
  return isValidDate(date) && date <= today && date >= addDays(today, -366) ? date : null;
}

async function sendHours(context, store, worker) {
  const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
  const today = todayInMichigan();
  const clients = await activeClients(store);
  const workDate = readWorkDate(form?.get("workDate"), today);
  const job = readJob(form?.get("job"), clients);
  const hours = parseHours(form?.get("hours"));
  const description = clean(form?.get("description"), 200);
  let problem = "";
  if (!form) problem = "The form could not be read. Please try again.";
  else if (!workDate) problem = "Enter the date you worked: today or a day in the past year.";
  else if (job.error) problem = "Choose one of the jobs in the list.";
  else if (!hours) problem = "Enter your hours like 8, 7.5 or 7:30 (up to 24).";
  else if (description === null) problem = "Keep what you did under 200 characters.";
  if (problem) return crewHome(context, store, worker, { status: errorNotice(problem), code: 400 });

  const entry = {
    id: randomId(12), workerId: worker.id, workerName: worker.name, kind: "hours", status: "submitted",
    clientSlug: job.slug, workDate, hours, amountCents: 0, description,
    createdAt: new Date().toISOString(), submittedAt: new Date().toISOString()
  };
  await putLabor(store, entry);
  await record(store, {
    actor: "crew", action: "labor.hours-sent", clientSlug: job.slug || null, ip: context.kit.requestIp(context.request),
    summary: `${worker.name} sent ${hoursText(hours)} on ${workDate} for ${jobNameOf(clients, job.slug)}`, data: { laborId: entry.id, workerId: worker.id }
  });
  return context.kit.redirectResponse("/clients/crew?notice=hours-sent");
}

async function sendBill(context, store, worker) {
  const { kit, env } = context;
  const form = await readBoundedMultipart(context.request, MAX_UPLOAD_BYTES + 8192);
  const today = todayInMichigan();
  const clients = await activeClients(store);
  const job = readJob(form?.get("job"), clients);
  const invoiceNumber = clean(form?.get("invoiceNumber"), 40);
  const invoiceDate = readWorkDate(form?.get("invoiceDate"), today);
  const through = readWorkDate(form?.get("through"), today);
  const amountCents = parseMoney(String(form?.get("amount") || ""));
  const description = clean(form?.get("description"), 200);
  const file = form?.get("file");
  const hasFile = file && typeof file.arrayBuffer === "function" && file.size > 0;
  let problem = "";
  if (!form) problem = "The form could not be read. Please try again.";
  else if (job.error) problem = "Choose one of the jobs in the list.";
  else if (!invoiceNumber) problem = "Enter your invoice number.";
  else if (!invoiceDate) problem = "Enter the invoice date: today or a day in the past year.";
  else if (!amountCents || amountCents > MAX_TOTAL_CENTS) problem = "Enter the invoice amount in dollars, like 1250 or 1250.50.";
  else if (!through) problem = "Enter the last day of the work this invoice covers.";
  else if (!description) problem = "Say what you provided, like framing labor or electrical rough-in.";
  if (!problem && (await listLabor(store, { workerId: worker.id })).some((entry) => entry.kind === "invoice" && entry.status !== "returned" && entry.invoiceNumber.toLowerCase() === invoiceNumber.toLowerCase())) {
    problem = `You already sent invoice ${invoiceNumber}. If it was returned to you, send it again with its corrections.`;
  }
  let bytes = null;
  let fileType = "";
  if (!problem && hasFile) {
    bytes = new Uint8Array(await file.arrayBuffer());
    fileType = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 ? "application/pdf" : String(file.type || "").split(";")[0].trim().toLowerCase();
    if (bytes.byteLength > MAX_UPLOAD_BYTES || !BILL_FILE_TYPES.has(fileType)) problem = "Attach your invoice as a PDF or photo under 20 MB, or leave it off.";
  }
  if (problem) return crewHome(context, store, worker, { status: errorNotice(problem), code: 400 });

  const id = randomId(12);
  const entry = {
    id, workerId: worker.id, workerName: worker.name, kind: "invoice",
    status: job.slug ? "waiver" : "submitted",
    clientSlug: job.slug, workDate: invoiceDate, through, invoiceNumber, amountCents, description,
    final: form.get("final") === "yes",
    createdAt: new Date().toISOString()
  };
  if (bytes) {
    const name = kit.safeFileName(file.name);
    entry.fileKey = `crew/${worker.id}/bills/${id}/${name}`;
    entry.fileName = name;
    entry.fileType = fileType;
    await putFile(store, entry.fileKey, bytes, fileType);
  }
  if (!job.slug) entry.submittedAt = entry.createdAt;
  await putLabor(store, entry);
  if (job.slug) return kit.redirectResponse(`/clients/crew/bills/${encodeURIComponent(id)}/waiver`);
  await billSent(context, store, worker, entry, clients);
  return kit.redirectResponse("/clients/crew?notice=bill-sent-shop");
}

// Logs a sent invoice and tells the builder. A failed email never fails the invoice.
async function billSent(context, store, worker, entry, clients) {
  const { env, kit } = context;
  const job = entry.clientSlug ? jobNameOf(clients, entry.clientSlug) : "";
  await record(store, {
    actor: "crew", action: "labor.invoice-sent", clientSlug: entry.clientSlug || null, amountCents: entry.amountCents, ip: kit.requestIp(context.request),
    summary: `${worker.name} sent invoice ${entry.invoiceNumber} for ${money(entry.amountCents)}${job ? ` on ${job}` : ""}${entry.waiver ? ` with a signed ${entry.waiver.name.toLowerCase()}` : ""}`,
    data: { laborId: entry.id, workerId: worker.id }
  });
  try {
    await sendEmail(env, { to: adminEmail(env), ...crewBillMessage({ worker, entry, jobName: job, adminUrl: `${new URL(context.request.url).origin}/clients/admin/labor` }), category: "crew-bill" });
  } catch (error) {
    console.error(JSON.stringify({ message: "crew invoice email failed", error: error instanceof Error ? error.message : "Unknown error" }));
  }
}

async function waiverValues(store, worker, entry, form = null) {
  const [employer, client] = await Promise.all([getEmployer(store), getClient(store, entry.clientSlug)]);
  const base = {
    party: employer.legalName,
    provided: entry.description,
    property: client?.siteAddress || "",
    amountCents: entry.amountCents,
    through: entry.through,
    coversAll: undefined,
    claimant: worker.company || worker.name,
    address: worker.address || "",
    phone: worker.phone || "",
    signerName: worker.name
  };
  if (!form) return { values: base, jobName: client?.name || entry.clientSlug };
  const typed = {
    ...base,
    property: String(form.get("property") || "").trim(),
    provided: String(form.get("provided") || "").trim(),
    claimant: String(form.get("claimant") || "").trim(),
    address: String(form.get("address") || "").trim(),
    phone: String(form.get("phone") || "").trim(),
    coversAll: form.get("coversAll") === "yes" ? true : form.get("coversAll") === "no" ? false : undefined,
    signerName: String(form.get("name") || "").trim()
  };
  let error = "";
  if (!typed.property || typed.property.length > 200) error = "Enter the property the work was for (the job site's address).";
  else if (!typed.provided || typed.provided.length > 200) error = "Enter what you provided.";
  else if (!typed.claimant || typed.claimant.length > 120) error = "Enter the lien claimant: your name, or your company's.";
  else if (!typed.address || typed.address.length > 160) error = "Enter your address.";
  else if (!typed.phone || typed.phone.replaceAll(/\D/gu, "").length < 10 || typed.phone.length > 30) error = "Enter your telephone number with area code.";
  else if (!entry.final && typed.coversAll === undefined) error = "Choose whether this waiver covers all amounts due to you through the date shown.";
  return { values: typed, jobName: client?.name || entry.clientSlug, error };
}

async function handleWaiver(context, store, worker, entry, method) {
  const { kit } = context;
  if (entry.status !== "waiver") return kit.redirectResponse("/clients/crew?notice=not-open");
  if (method === "GET" || method === "HEAD") {
    const { values, jobName } = await waiverValues(store, worker, entry);
    return kit.htmlResponse(waiverPage({ entry, values, jobName }), 200, undefined, { scripts: true });
  }
  if (method !== "POST") return kit.methodNotAllowedResponse(["GET", "HEAD", "POST"]);
  const form = await readBoundedForm(context.request, MAX_SIGN_FORM_BYTES);
  if (!form) return kit.redirectResponse(`/clients/crew/bills/${encodeURIComponent(entry.id)}/waiver`);
  const { values, jobName, error } = await waiverValues(store, worker, entry, form);
  const signed = error ? null : readSigner(form, context.request, kit);
  if (error || signed.error) return kit.htmlResponse(waiverPage({ entry, values, jobName, error: error || signed.error }), 400, undefined, { scripts: true });

  const kind = entry.final ? "full-conditional" : "partial-conditional";
  const { signer } = signed;
  const bytes = await typesetWaiver(kind, values, {
    signer,
    reference: `Invoice ${entry.invoiceNumber} from ${values.claimant} to ${values.party}.`,
    audit: auditLine(signer.name, signer.ip)
  });
  const fileKey = `crew/${worker.id}/bills/${entry.id}/lien-waiver.pdf`;
  await putFile(store, fileKey, bytes, "application/pdf");
  const updated = {
    ...entry,
    status: "submitted",
    submittedAt: new Date().toISOString(),
    description: values.provided,
    waiver: { kind, name: WAIVERS[kind].name, fileKey, signedAt: signer.signedAt, signerName: signer.name, ip: signer.ip, claimant: values.claimant, property: values.property, coversAll: entry.final ? true : values.coversAll }
  };
  await putLabor(store, updated);
  // Remembered for their next waiver.
  if (!worker.address || !worker.phone) await putWorker(store, { ...worker, address: worker.address || values.address, phone: worker.phone || values.phone });
  await billSent(context, store, worker, updated, await activeClients(store));
  return kit.redirectResponse("/clients/crew?notice=bill-sent");
}

async function handleCrewForm(context, store, worker, key, action, method) {
  const { kit, env } = context;
  const spec = FORMS[key];
  if (!spec || !formKeys(worker).includes(key)) return kit.notFound();
  if (action === "pdf") {
    if (method !== "GET" && method !== "HEAD") return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    return (await paperworkPdf(store, env, worker, key, kit)) || kit.notFound();
  }
  if (!secureReady(env)) return kit.redirectResponse("/clients/crew");
  // Section 1 of the I-9 is signed once; My Home Builder then completes Section 2.
  if (key === "i9" && worker.paperwork?.i9) return kit.redirectResponse("/clients/crew?notice=not-open");
  const section = key === "i9" ? "section1" : null;
  const page = (values, error = "") => paperworkFormPage({ spec, values, error, action: `/clients/crew/forms/${key}`, backPath: "/clients/crew", section, signerName: worker.name });
  if (method === "GET" || method === "HEAD") {
    return kit.htmlResponse(page(await startingValues(store, env, worker, key)), 200, undefined, { scripts: true });
  }
  if (method !== "POST") return kit.methodNotAllowedResponse(["GET", "HEAD", "POST"]);
  const form = await readBoundedForm(context.request, MAX_SIGN_FORM_BYTES);
  if (!form) return kit.redirectResponse(`/clients/crew/forms/${key}`);
  const answers = readAnswers(spec, form, { section });
  if (answers.error) return kit.htmlResponse(page(answers.values, answers.error), 400, undefined, { scripts: true });
  const signed = readSigner(form, context.request, kit);
  if (signed.error) return kit.htmlResponse(page(Object.fromEntries(form.entries()), signed.error), 400, undefined, { scripts: true });
  await signForm(store, env, worker, key, answers.values, signed.signer);
  await record(store, {
    actor: "crew", action: "labor.paperwork-signed", ip: signed.signer.ip,
    summary: `${worker.name} signed ${spec.title}${key === "i9" ? " Section 1" : ""}`, data: { workerId: worker.id, form: key }
  });
  return kit.redirectResponse("/clients/crew?notice=form-signed");
}

async function handleCrewDocument(context, store, worker, id, action, method) {
  const { kit } = context;
  const document = await getDocument(store, crewSlug(worker.id), id);
  if (!document) return kit.notFound();
  const downloadPath = `/clients/crew/documents/${encodeURIComponent(document.id)}`;
  const signPath = `${downloadPath}/sign`;
  if (!action) {
    if (method !== "GET" && method !== "HEAD") return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    return (await kit.documentDownload(store, document)) || kit.notFound();
  }
  if (!document.requiresClientSignature) return kit.redirectResponse("/clients/crew");
  if (method === "GET" || method === "HEAD") {
    return kit.htmlResponse(signPage({ document, party: "client", actionPath: signPath, backPath: downloadPath, crew: true, authenticated: false }), 200, undefined, { scripts: true });
  }
  if (method !== "POST") return kit.methodNotAllowedResponse(["GET", "HEAD", "POST"]);
  const form = await readBoundedForm(context.request, MAX_SIGN_FORM_BYTES);
  const result = form ? await kit.applySignature(store, document, "client", form, context.request) : { error: "The signature could not be read." };
  if (result.error) {
    return kit.htmlResponse(signPage({ document, party: "client", actionPath: signPath, backPath: downloadPath, error: result.error, crew: true, authenticated: false }), 400, undefined, { scripts: true });
  }
  return kit.redirectResponse("/clients/crew?notice=signed");
}

export async function handleCrew(context, store, pathname, url) {
  const { kit, env } = context;
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";
  const secret = env.CLIENT_PORTAL_SESSION_SECRET;
  const origin = url.origin;

  // A failed sign-in counts against the visitor's address, like a client login (guard.js).
  if (pathname === "/clients/crew/login") {
    if (method !== "POST") return kit.redirectResponse("/clients/crew");
    const block = await kit.signInBlock(store, kit.requestIp(context.request));
    if (block) return kit.blockedResponse(block);
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const email = String(form?.get("email") || "").trim().toLowerCase();
    const worker = isValidEmail(email) ? await findWorkerByEmail(store, email) : null;
    const matched = worker && worker.active !== false && worker.passwordHash && (await verifyPassword(String(form?.get("password") || ""), worker.passwordHash));
    if (!matched) {
      const started = await kit.failedSignIn(store, context.request, "crew");
      return started ? kit.blockedResponse(started) : kit.htmlResponse(crewLoginPage({ error: "That email and password did not match.", email }), 401);
    }
    await kit.signInSucceeded(store, kit.requestIp(context.request));
    await putWorker(store, { ...worker, lastSignInAt: new Date().toISOString() });
    await record(store, { actor: "crew", action: "crew.signed-in", ip: kit.requestIp(context.request), summary: `${worker.name} signed in to the crew portal`, data: { workerId: worker.id } });
    return kit.redirectResponse("/clients/crew", await createCrewSession(secret, worker));
  }

  if (pathname === "/clients/crew/logout") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    return kit.redirectResponse("/clients/crew", expiredCrewSession());
  }

  // Always the same answer, so the form does not tell who has an account.
  if (pathname === "/clients/crew/forgot") {
    if (method !== "POST") return kit.redirectResponse("/clients/crew");
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const email = String(form?.get("email") || "").trim().toLowerCase();
    const worker = isValidEmail(email) ? await findWorkerByEmail(store, email) : null;
    if (worker && worker.active !== false) {
      const sent = await sendLink(env, store, worker, origin, { reset: Boolean(worker.passwordHash) });
      await record(store, { actor: "crew", action: "crew.link-requested", ip: kit.requestIp(context.request), summary: `A password link was requested for ${worker.name}${sent.ok ? "" : " (the email did not go out)"}`, data: { workerId: worker.id } });
    }
    return kit.htmlResponse(crewLoginPage({ sent: true }));
  }

  const welcome = pathname.match(/^\/clients\/crew\/welcome\/([^/]+)$/u);
  if (welcome) {
    const token = kit.decodeSegment(welcome[1]);
    const worker = await workerForToken(store, token);
    if (!worker) return kit.htmlResponse(crewLinkExpiredPage(), 410);
    const reset = worker.invite.kind === "reset";
    if (isRead) return kit.htmlResponse(crewPasswordPage({ worker, token, reset }));
    if (method !== "POST") return kit.methodNotAllowedResponse(["GET", "HEAD", "POST"]);
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const password = String(form?.get("password") || "");
    let error = "";
    if (password.length < 10 || password.length > 200) error = "Use at least 10 characters.";
    else if (password !== String(form?.get("confirm") || "")) error = "The two passwords did not match.";
    if (error) return kit.htmlResponse(crewPasswordPage({ worker, token, reset, error }), 400);
    const updated = { ...worker, passwordHash: await hashPassword(password), passwordSetAt: new Date().toISOString(), invite: null, sessionVersion: (worker.sessionVersion || 1) + 1, lastSignInAt: new Date().toISOString() };
    await putWorker(store, updated);
    await record(store, { actor: "crew", action: "crew.password-set", ip: kit.requestIp(context.request), summary: `${worker.name} ${reset ? "reset" : "chose"} their crew portal password`, data: { workerId: worker.id } });
    return kit.redirectResponse("/clients/crew?notice=password-set", await createCrewSession(secret, updated));
  }

  const worker = await signedInWorker(context, store);
  if (pathname === "/clients/crew") {
    if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    if (!worker) return kit.htmlResponse(crewLoginPage());
    return crewHome(context, store, worker, { status: noticeFrom(url, CREW_NOTICES) });
  }
  if (!worker) return kit.redirectResponse("/clients/crew");

  // Important notes, for team leaders: add one, or mark one In progress, Completed or Contingent.
  const noteMatch = pathname.match(new RegExp(`^/clients/crew/notes(?:/${ID}/status)?$`, "u"));
  if (noteMatch) {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    if (!worker.teamLeader) return kit.redirectResponse("/clients/crew");
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const ip = kit.requestIp(context.request);
    const result = noteMatch[1]
      ? await changeNote(store, noteMatch[1], String(form?.get("status") || ""), { by: worker.name, actor: "crew", ip })
      : await addNote(store, { text: form?.get("text"), author: { kind: "crew", name: worker.name, workerId: worker.id }, ip });
    if (!result) return kit.notFound();
    return kit.redirectResponse(`/clients/crew?notice=${result}#${noteMatch[1] ? `note-${noteMatch[1]}` : "crew-notes-heading"}`);
  }

  if (pathname === "/clients/crew/hours") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    if (worker.kind !== "employee") return kit.redirectResponse("/clients/crew");
    return sendHours(context, store, worker);
  }
  if (pathname === "/clients/crew/bills") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    if (worker.kind !== "subcontractor") return kit.redirectResponse("/clients/crew");
    return sendBill(context, store, worker);
  }

  const bill = pathname.match(new RegExp(`^/clients/crew/bills/${ID}/(waiver|waiver\\.pdf|file)$`, "u"));
  if (bill) {
    const entry = await getLabor(store, bill[1]);
    if (!entry || entry.workerId !== worker.id) return kit.notFound();
    if (bill[2] === "waiver") return handleWaiver(context, store, worker, entry, method);
    if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    const key = bill[2] === "file" ? entry.fileKey : entry.waiver?.fileKey;
    const object = key ? await getFile(store, key) : null;
    if (!object) return kit.notFound();
    return kit.fileResponse(object, bill[2] === "file" ? entry.fileName : `Lien waiver - invoice ${entry.invoiceNumber}.pdf`, bill[2] === "file" ? entry.fileType : "application/pdf");
  }

  const formMatch = pathname.match(/^\/clients\/crew\/forms\/([a-z0-9]+)(?:\/(pdf))?$/u);
  if (formMatch) return handleCrewForm(context, store, worker, formMatch[1], formMatch[2] || "", method);

  if (pathname === "/clients/crew/documents/upload") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    const form = await readBoundedMultipart(context.request, MAX_UPLOAD_BYTES + 4096);
    // What it is decides its section: a certificate of insurance, a license (onboarding), or other.
    const section = { insurance: "insurance", license: "onboarding" }[String(form?.get("kind") || "")] || "other";
    const result = form ? await kit.storeUpload(store, crewSlug(worker.id), form.get("file"), "crew", { section, crewName: worker.name }) : { error: "upload-failed" };
    return kit.redirectResponse(`/clients/crew?notice=${result.error === "files-not-configured" ? "upload-failed" : result.error || "uploaded"}`);
  }

  const documentMatch = pathname.match(/^\/clients\/crew\/documents\/([^/]+)(?:\/(sign))?$/u);
  if (documentMatch) return handleCrewDocument(context, store, worker, kit.decodeSegment(documentMatch[1]), documentMatch[2] || "", method);

  // Add photos: to one of the active jobs' galleries, with a note. Crew open only the photos they
  // added.
  if (pathname === "/clients/crew/photos") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    const form = await readBoundedMultipart(context.request, kit.MAX_PHOTO_BATCH_BYTES);
    if (!form) return kit.redirectResponse("/clients/crew?notice=photos-invalid");
    const job = (await activeClients(store)).find((client) => client.slug === String(form.get("job") || ""));
    if (!job) return kit.redirectResponse("/clients/crew?notice=photo-job-invalid");
    const result = await kit.storePhotos(store, job, form, { uploadedBy: "crew", uploaderName: worker.name, workerId: worker.id, ip: kit.requestIp(context.request) });
    return kit.redirectResponse(`/clients/crew?notice=${result.error ? "photos-invalid" : "photos-added"}`);
  }

  const photoMatch = pathname.match(new RegExp(`^/clients/crew/photos/${ID}$`, "u"));
  if (photoMatch) {
    if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    const photo = await getPhoto(store, photoMatch[1]);
    if (!photo || photo.uploadedBy !== "crew" || photo.workerId !== worker.id) return kit.notFound();
    return (await kit.photoResponse(store, photo)) || kit.notFound();
  }

  return kit.notFound();
}

// ---------- Admin: Labor ----------

function parseLaborPayment(form) {
  const method = String(form?.get("method") || "");
  const methodName = clean(form?.get("methodName"), 60) ?? null;
  const reference = clean(form?.get("reference"), 80) ?? null;
  const paidOn = String(form?.get("paidOn") || "").trim();
  if (!Object.hasOwn(LABOR_PAYMENT_METHODS, method) || methodName === null || reference === null) return { error: "invalid" };
  if (method === "other" && !methodName) return { error: "payment-other-required" };
  if (!isValidDate(paidOn)) return { error: "payment-date-invalid" };
  return { method, methodName: method === "other" ? methodName : "", reference, paidOn, label: [method === "other" ? methodName : LABOR_PAYMENT_METHODS[method], reference].filter(Boolean).join(" ") };
}

function readProfile(form) {
  const profile = {
    name: clean(form?.get("name"), 120),
    email: String(form?.get("email") || "").trim().toLowerCase(),
    phone: clean(form?.get("phone"), 30),
    trade: clean(form?.get("trade"), 60),
    company: clean(form?.get("company"), 120),
    address: form?.has("address") ? clean(form.get("address"), 160) : undefined,
    teamLeader: form?.get("teamLeader") === "yes",
    startDate: String(form?.get("startDate") || "").trim()
  };
  const rate = String(form?.get("rate") || "").trim();
  const rateCents = rate ? parseMoney(rate) : null;
  if (!profile.name) return { error: "Enter their name." };
  if (!isValidEmail(profile.email)) return { error: "Enter their email address. They sign in to the crew portal with it." };
  if (profile.phone === null || profile.trade === null || profile.company === null || profile.address === null) return { error: "One of the fields is too long." };
  if (rate && (!rateCents || rateCents > 100000)) return { error: "Enter the hourly rate in dollars, like 28 or 28.50." };
  if (profile.startDate && !isValidDate(profile.startDate)) return { error: "Enter the start date as a date." };
  return { profile: { ...profile, hourlyRateCents: rateCents }, rate };
}

async function laborPage(context, store, url, { status = null, code = 200 } = {}) {
  const [workers, entries, clients, employer] = await Promise.all([listWorkers(store), listLabor(store, { limit: 400 }), listClients(store), getEmployer(store)]);
  return context.kit.scriptedHtmlResponse(adminLaborPage({
    workers, entries, clients, employer, today: todayInMichigan(), secureReady: secureReady(context.env),
    status: status || noticeFrom(url, LABOR_NOTICES)
  }), code);
}

async function workerPage(context, store, worker, url, { status = null, code = 200 } = {}) {
  const [entries, clients, documents] = await Promise.all([
    listLabor(store, { workerId: worker.id }),
    listClients(store),
    listDocuments(store, crewSlug(worker.id))
  ]);
  return context.kit.htmlResponse(adminWorkerPage({ worker, entries, clients, documents, secureReady: secureReady(context.env), status: status || noticeFrom(url, LABOR_NOTICES) }), code);
}

async function addWorker(context, store, url) {
  const { kit, env } = context;
  const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
  const kind = String(form?.get("kind") || "");
  const read = readProfile(form);
  let problem = read.error || "";
  if (!problem && !Object.hasOwn(WORKER_KINDS, kind)) problem = "Choose employee or subcontractor.";
  if (!problem && (await findWorkerByEmail(store, read.profile.email))) problem = `${read.profile.email} is already in Labor.`;
  if (problem) return laborPage(context, store, url, { status: errorNotice(problem), code: 400 });

  const worker = {
    id: randomId(12), kind, ...read.profile, address: "", active: true, sessionVersion: 1, paperwork: {},
    createdAt: new Date().toISOString()
  };
  await putWorker(store, worker);
  await record(store, { actor: "admin", action: "crew.added", ip: kit.requestIp(context.request), summary: `Added ${worker.name} (${WORKER_KINDS[kind]}) to Labor`, data: { workerId: worker.id } });
  const sent = await sendLink(env, store, worker, url.origin, { reset: false });
  return kit.redirectResponse(`/clients/admin/labor/workers/${encodeURIComponent(worker.id)}?notice=${sent.ok ? "worker-added" : "worker-added-no-invite"}`);
}

async function saveEmployer(context, store) {
  const { kit } = context;
  const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
  const fields = { legalName: 120, ein: 10, street: 120, city: 60, state: 2, zip: 10, contactName: 80, contactPhone: 30 };
  const employer = {};
  for (const [name, max] of Object.entries(fields)) {
    employer[name] = clean(form?.get(name), max);
    if (employer[name] === null) return kit.redirectResponse("/clients/admin/labor?notice=invalid");
  }
  employer.state = employer.state.toUpperCase();
  const einDigits = employer.ein.replaceAll(/\D/gu, "");
  if (employer.ein && einDigits.length !== 9) return laborPage(context, store, new URL(context.request.url), { status: errorNotice("Enter the EIN as 9 digits, like 12-3456789."), code: 400 });
  if (einDigits) employer.ein = `${einDigits.slice(0, 2)}-${einDigits.slice(2)}`;
  if (!employer.legalName || !employer.street || !employer.city || !/^[A-Z]{2}$/u.test(employer.state) || !/^\d{5}(?:-\d{4})?$/u.test(employer.zip)) {
    return laborPage(context, store, new URL(context.request.url), { status: errorNotice("Enter the business name and its full address."), code: 400 });
  }
  await putSetting(store, "employer", employer);
  await record(store, { actor: "admin", action: "crew.employer-saved", ip: kit.requestIp(context.request), summary: "Saved the employer details printed on crew paperwork" });
  return kit.redirectResponse("/clients/admin/labor?notice=employer-saved");
}

async function handleWorker(context, store, worker, action, rest, url) {
  const { kit, env } = context;
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";
  const base = `/clients/admin/labor/workers/${encodeURIComponent(worker.id)}`;
  const ip = kit.requestIp(context.request);

  if (!action) {
    if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    return workerPage(context, store, worker, url);
  }

  if (action === "profile" && method === "POST") {
    const read = readProfile(await readBoundedForm(context.request, MAX_FORM_BYTES));
    let problem = read.error || "";
    if (!problem && read.profile.email !== worker.email) {
      const other = await findWorkerByEmail(store, read.profile.email);
      if (other && other.id !== worker.id) problem = `${read.profile.email} is already in Labor.`;
    }
    if (problem) return workerPage(context, store, worker, url, { status: errorNotice(problem), code: 400 });
    await putWorker(store, { ...worker, ...read.profile, address: read.profile.address ?? worker.address ?? "" });
    await record(store, { actor: "admin", action: "crew.profile-saved", ip, summary: `Saved ${read.profile.name}'s profile`, data: { workerId: worker.id } });
    return kit.redirectResponse(`${base}?notice=profile-saved`);
  }

  if (action === "invite" && method === "POST") {
    const sent = await sendLink(env, store, worker, url.origin, { reset: Boolean(worker.passwordHash) });
    await record(store, { actor: "admin", action: "crew.link-sent", ip, summary: `Emailed ${worker.name} a ${worker.passwordHash ? "password reset" : "crew portal invite"} link${sent.ok ? "" : " (the email did not go out)"}`, data: { workerId: worker.id } });
    return kit.redirectResponse(`${base}?notice=${sent.ok ? "invite-sent" : "invite-failed"}`);
  }

  if (action === "active" && method === "POST") {
    const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
    const active = form?.get("active") === "yes";
    await putWorker(store, { ...worker, active, sessionVersion: (worker.sessionVersion || 1) + (active ? 0 : 1), invite: active ? worker.invite : null });
    await record(store, { actor: "admin", action: active ? "crew.reactivated" : "crew.deactivated", ip, summary: `${active ? "Reactivated" : "Deactivated"} ${worker.name}`, data: { workerId: worker.id } });
    return kit.redirectResponse(`${base}?notice=${active ? "reactivated" : "deactivated"}`);
  }

  if (action === "new-hire" && method === "POST") {
    await putWorker(store, { ...worker, newHireReportedOn: todayInMichigan() });
    await record(store, { actor: "admin", action: "crew.new-hire-reported", ip, summary: `Marked ${worker.name} reported to the Michigan New Hire Operations Center`, data: { workerId: worker.id } });
    return kit.redirectResponse(`${base}?notice=new-hire-reported`);
  }

  if (action === "documents" && !rest[0]) {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    const form = await readBoundedMultipart(context.request, MAX_UPLOAD_BYTES + 4096);
    const result = form
      ? await kit.storeUpload(store, crewSlug(worker.id), form.get("file"), "admin", {
        section: form.get("section"),
        crewName: worker.name,
        requiresClientSignature: form.get("requiresClientSignature") === "yes",
        requiresAdminSignature: form.get("requiresAdminSignature") === "yes"
      })
      : { error: "upload-failed" };
    return kit.redirectResponse(`${base}?notice=${result.error || "document-shared"}`);
  }

  if (action === "documents" && rest[0]) {
    const document = await getDocument(store, crewSlug(worker.id), kit.decodeSegment(rest[0]));
    if (!document) return kit.notFound();
    const downloadPath = `${base}/documents/${encodeURIComponent(document.id)}`;
    const signPath = `${downloadPath}/sign`;
    if (!rest[1]) {
      if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
      return (await kit.documentDownload(store, document)) || kit.notFound();
    }
    if (rest[1] !== "sign") return kit.notFound();
    if (isRead) return kit.htmlResponse(signPage({ document, party: "admin", actionPath: signPath, backPath: downloadPath, admin: true, authenticated: false }), 200, undefined, { scripts: true });
    if (method !== "POST") return kit.methodNotAllowedResponse(["GET", "HEAD", "POST"]);
    const form = await readBoundedForm(context.request, MAX_SIGN_FORM_BYTES);
    const result = form ? await kit.applySignature(store, document, "admin", form, context.request) : { error: "The signature could not be read." };
    if (result.error) return kit.htmlResponse(signPage({ document, party: "admin", actionPath: signPath, backPath: downloadPath, error: result.error, admin: true, authenticated: false }), 400, undefined, { scripts: true });
    return kit.redirectResponse(`${base}?notice=signed`);
  }

  if (action === "forms" && rest[0] && FORMS[rest[0]] && formKeys(worker).includes(rest[0])) {
    const key = rest[0];
    if (rest[1] === "pdf") {
      if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
      const response = await paperworkPdf(store, env, worker, key, kit);
      if (!response) return kit.notFound();
      await record(store, { actor: "admin", action: "crew.paperwork-opened", ip, summary: `Downloaded ${worker.name}'s ${FORMS[key].title}`, data: { workerId: worker.id, form: key } });
      return response;
    }
    if (key === "i9" && rest[1] === "section2") return handleSection2(context, store, worker, base);
  }

  return kit.notFound();
}

// Section 2 of the I-9: the admin enters the documents they examined and signs. The form is
// filled again with Section 1's answers and the employee's signature, and both signatures.
async function handleSection2(context, store, worker, base) {
  const { kit, env } = context;
  const method = context.request.method;
  const spec = FORMS.i9;
  const done = worker.paperwork?.i9;
  if (!done || done.status === "complete") return kit.redirectResponse(base);
  const employer = await getEmployer(store);
  const page = (values, error = "") => paperworkFormPage({
    spec, values, error, admin: true, section: "section2", action: `${base}/forms/i9/section2`, backPath: base,
    signerName: employer.contactName,
    heading: `Section 2 for ${worker.name}`,
    lead: "Examine the employee's original, unexpired documents in person, within three business days after their first day of work, and enter what you saw. Then sign as the employer or authorized representative."
  });
  if (method === "GET" || method === "HEAD") {
    return kit.htmlResponse(page({ firstDay: worker.startDate || "", employerSigner: employer.contactName ? `${employer.contactName.split(" ").reverse().join(", ")}, Owner` : "" }), 200, undefined, { scripts: true });
  }
  if (method !== "POST") return kit.methodNotAllowedResponse(["GET", "HEAD", "POST"]);
  const form = await readBoundedForm(context.request, MAX_SIGN_FORM_BYTES);
  if (!form) return kit.redirectResponse(`${base}/forms/i9/section2`);
  const answers = readAnswers(spec, form, { section: "section2" });
  if (answers.error) return kit.htmlResponse(page(answers.values, answers.error), 400, undefined, { scripts: true });
  const signed = readSigner(form, context.request, kit);
  if (signed.error) return kit.htmlResponse(page(Object.fromEntries(form.entries()), signed.error), 400, undefined, { scripts: true });

  const saved = await getSecureJson(store, env, `crew/${worker.id}/i9.json`);
  if (!saved) return kit.redirectResponse(base);
  const image = saved.signer.image ? await getSecure(store, env, `crew/${worker.id}/i9-signature.png`) : null;
  const values = { ...saved.values, ...answers.values };
  const employerSigner = signed.signer;
  const bytes = await fillOfficialForm("i9", values, {
    employer, worker,
    signer: { name: saved.signer.name, image, signedOn: saved.signer.signedOn },
    employerSigner
  });
  await putSecure(store, env, `crew/${worker.id}/i9.pdf`, bytes);
  await putSecureJson(store, env, `crew/${worker.id}/i9.json`, { ...saved, values, employerSigner: { name: employerSigner.name, signedOn: employerSigner.signedOn, signedAt: employerSigner.signedAt, ip: employerSigner.ip } });
  await putWorker(store, { ...worker, startDate: worker.startDate || answers.values.firstDay, paperwork: { ...worker.paperwork, i9: { ...done, status: "complete", completedAt: employerSigner.signedAt, completedBy: employerSigner.name } } });
  await record(store, { actor: "admin", action: "crew.i9-completed", ip: employerSigner.ip, summary: `${employerSigner.name} completed Section 2 of ${worker.name}'s Form I-9`, data: { workerId: worker.id } });
  return kit.redirectResponse(`${base}?notice=section2-signed`);
}

async function handleEntry(context, store, entry, action) {
  const { kit } = context;
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";
  const ip = kit.requestIp(context.request);
  const back = "/clients/admin/labor";
  const clients = await listClients(store);
  const name = laborLabel(entry);

  if (action === "file" || action === "waiver") {
    if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    const key = action === "file" ? entry.fileKey : entry.waiver?.fileKey;
    const object = key ? await getFile(store, key) : null;
    if (!object) return kit.notFound();
    return kit.fileResponse(object, action === "file" ? entry.fileName : `Lien waiver - ${entry.workerName} - invoice ${entry.invoiceNumber}.pdf`, action === "file" ? entry.fileType : "application/pdf");
  }

  if (action === "paid" && isRead) {
    if (entry.status !== "approved") return kit.redirectResponse(`${back}?notice=not-waiting`);
    return kit.scriptedHtmlResponse(laborPayPage({ entry, today: todayInMichigan() }));
  }
  if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
  const form = await readBoundedForm(context.request, MAX_FORM_BYTES);
  const save = async (updated, event) => {
    await putLabor(store, updated);
    await record(store, { actor: "admin", ip, clientSlug: updated.clientSlug || null, labor: updated, data: { laborId: updated.id, workerId: updated.workerId }, ...event });
  };

  if (action === "approve") {
    if (entry.status !== "submitted") return kit.redirectResponse(`${back}?notice=not-waiting`);
    const job = readJob(form?.get("job"), clients);
    if (job.error) return kit.redirectResponse(`${back}?notice=job-invalid`);
    const amountCents = entry.kind === "hours" ? parseMoney(String(form?.get("amount") || "")) : entry.amountCents;
    if (!amountCents || amountCents > MAX_TOTAL_CENTS) return kit.redirectResponse(`${back}?notice=amount-required`);
    const updated = { ...entry, status: "approved", clientSlug: job.slug, amountCents, approvedAt: new Date().toISOString(), returnNote: "" };
    await save(updated, { action: "labor.approved", amountCents, summary: `Approved ${name} to ${jobNameOf(clients, job.slug)} · ${money(amountCents)}` });
    return kit.redirectResponse(`${back}?notice=approved`);
  }

  if (action === "return") {
    if (entry.status !== "submitted") return kit.redirectResponse(`${back}?notice=not-waiting`);
    const note = clean(form?.get("note"), 200) || "";
    await save({ ...entry, status: "returned", returnNote: note, returnedAt: new Date().toISOString() }, { action: "labor.returned", reason: "returned", summary: `Returned ${name}${note ? `: ${note}` : ""}` });
    return kit.redirectResponse(`${back}?notice=returned`);
  }

  if (action === "unapprove") {
    if (entry.status !== "approved") return kit.redirectResponse(`${back}?notice=not-waiting`);
    await save({ ...entry, status: "submitted", approvedAt: null }, { action: "labor.unapproved", reason: "unapproved", summary: `Undid the approval of ${name}` });
    return kit.redirectResponse(`${back}?notice=unapproved`);
  }

  if (action === "paid") {
    if (entry.status !== "approved") return kit.redirectResponse(`${back}?notice=not-waiting`);
    const payment = parseLaborPayment(form);
    if (payment.error) return kit.redirectResponse(`${back}?notice=${payment.error}`);
    const updated = { ...entry, status: "paid", payment: { ...payment, source: "manual", recordedAt: new Date().toISOString() } };
    await save(updated, { action: "labor.paid", amountCents: entry.amountCents, summary: `Paid ${name} · ${money(entry.amountCents)} by ${payment.label}` });
    return kit.redirectResponse(`${back}?notice=labor-paid`);
  }

  if (action === "unpaid") {
    if (entry.status !== "paid") return kit.redirectResponse(`${back}?notice=not-waiting`);
    // Paid by a bank transaction: unfiling it puts the work back to how it was.
    if (entry.payment?.source === "bank" && (await unfileLaborPayment(store, entry, { ip }))) {
      const now = await getLabor(store, entry.id);
      if (now.status !== "paid") return kit.redirectResponse(`${back}?notice=labor-unpaid`);
      await save({ ...now, status: "approved", payment: null }, { action: "labor.unpaid", reason: "payment-removed", summary: `Marked ${name} unpaid` });
      return kit.redirectResponse(`${back}?notice=labor-unpaid`);
    }
    await save({ ...entry, status: "approved", payment: null }, { action: "labor.unpaid", reason: "payment-removed", summary: `Marked ${name} unpaid` });
    return kit.redirectResponse(`${back}?notice=labor-unpaid`);
  }

  return kit.notFound();
}

// Only reached with an admin session (handler.js checks it).
export async function handleAdminLabor(context, store, pathname, url) {
  const { kit } = context;
  const method = context.request.method;
  const isRead = method === "GET" || method === "HEAD";

  if (pathname === "/clients/admin/labor") {
    if (!isRead) return kit.methodNotAllowedResponse(["GET", "HEAD"]);
    return laborPage(context, store, url);
  }
  if (pathname === "/clients/admin/labor/workers") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    return addWorker(context, store, url);
  }
  if (pathname === "/clients/admin/labor/employer") {
    if (method !== "POST") return kit.methodNotAllowedResponse(["POST"]);
    return saveEmployer(context, store);
  }

  const workerMatch = pathname.match(new RegExp(`^/clients/admin/labor/workers/${ID}(?:/([a-z0-9-]+))?(?:/([^/]+))?(?:/([a-z0-9]+))?$`, "u"));
  if (workerMatch) {
    const worker = await getWorker(store, workerMatch[1]);
    if (!worker) return kit.notFound();
    return handleWorker(context, store, worker, workerMatch[2] || "", [workerMatch[3], workerMatch[4]].filter(Boolean), url);
  }

  const entryMatch = pathname.match(new RegExp(`^/clients/admin/labor/entries/${ID}/(approve|return|unapprove|paid|unpaid|file|waiver)$`, "u"));
  if (entryMatch) {
    const entry = await getLabor(store, entryMatch[1]);
    if (!entry) return kit.notFound();
    return handleEntry(context, store, entry, entryMatch[2]);
  }

  return kit.notFound();
}
