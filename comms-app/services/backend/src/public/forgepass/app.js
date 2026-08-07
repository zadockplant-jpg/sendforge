const API_ROOT = "/v1/auth";
const SESSION_KEY = "forgepass.accessToken";

const elements = {
  connectionPill: document.querySelector("#connection-pill"),
  connectionLabel: document.querySelector("#connection-label"),
  secureContextStatus: document.querySelector("#secure-context-status"),
  webauthnStatus: document.querySelector("#webauthn-status"),
  sessionStatus: document.querySelector("#session-status"),
  sessionIdentity: document.querySelector("#session-identity"),
  statusMessage: document.querySelector("#status-message"),
  signOutButton: document.querySelector("#sign-out-button"),
  passwordForm: document.querySelector("#password-form"),
  passwordSubmit: document.querySelector("#password-submit"),
  email: document.querySelector("#email"),
  password: document.querySelector("#password"),
  enrollmentPassword: document.querySelector("#enrollment-password"),
  enrollButton: document.querySelector("#enroll-button"),
  passkeyLoginButton: document.querySelector("#passkey-login-button"),
  refreshButton: document.querySelector("#refresh-button"),
  credentialList: document.querySelector("#credential-list"),
  signInStep: document.querySelector("#step-sign-in"),
  enrollStep: document.querySelector("#step-enroll"),
  passkeyStep: document.querySelector("#step-passkey"),
};

const browser = {
  secure: window.isSecureContext,
  webauthn:
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function",
};

const state = {
  accessToken: readSessionToken(),
  user: null,
  credentials: [],
  ceremonyActive: false,
  passkeyAuthenticated: false,
};

function readSessionToken() {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) || "";
  } catch {
    return "";
  }
}

function storeSessionToken(token) {
  try {
    window.sessionStorage.setItem(SESSION_KEY, token);
  } catch {
    throw new Error("This browser is blocking session storage. Allow it for this page and try again.");
  }
}

function clearSessionToken() {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // The in-memory session is still cleared if browser storage is unavailable.
  }
}

function bufferToBase64URL(value) {
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError("Expected binary WebAuthn data.");
  }

  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  return window
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64URLToBuffer(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("The server returned invalid WebAuthn data.");
  }

  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary;

  try {
    binary = window.atob(padded);
  } catch {
    throw new TypeError("The server returned malformed WebAuthn data.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function serializeExtensionValue(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return bufferToBase64URL(value);
  }
  if (Array.isArray(value)) {
    return value.map(serializeExtensionValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [key, serializeExtensionValue(childValue)]),
    );
  }
  return value;
}

function prepareRegistrationOptions(options) {
  if (!options?.challenge || !options?.user?.id || !Array.isArray(options.pubKeyCredParams)) {
    throw new Error("The server returned incomplete registration options.");
  }

  return {
    ...options,
    challenge: base64URLToBuffer(options.challenge),
    user: {
      ...options.user,
      id: base64URLToBuffer(options.user.id),
    },
    excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
      ...credential,
      id: base64URLToBuffer(credential.id),
    })),
  };
}

function prepareAuthenticationOptions(options) {
  if (!options?.challenge) {
    throw new Error("The server returned incomplete authentication options.");
  }

  return {
    ...options,
    challenge: base64URLToBuffer(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((credential) => ({
      ...credential,
      id: base64URLToBuffer(credential.id),
    })),
  };
}

function registrationCredentialToJSON(credential) {
  const response = credential.response;
  const publicKey = typeof response.getPublicKey === "function" ? response.getPublicKey() : null;
  const authenticatorData =
    typeof response.getAuthenticatorData === "function" ? response.getAuthenticatorData() : null;
  const publicKeyAlgorithm =
    typeof response.getPublicKeyAlgorithm === "function" ? response.getPublicKeyAlgorithm() : null;

  return {
    id: credential.id,
    rawId: bufferToBase64URL(credential.rawId),
    response: {
      attestationObject: bufferToBase64URL(response.attestationObject),
      clientDataJSON: bufferToBase64URL(response.clientDataJSON),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
      ...(publicKey ? { publicKey: bufferToBase64URL(publicKey) } : {}),
      ...(authenticatorData ? { authenticatorData: bufferToBase64URL(authenticatorData) } : {}),
      ...(publicKeyAlgorithm !== null ? { publicKeyAlgorithm } : {}),
    },
    type: credential.type,
    clientExtensionResults: serializeExtensionValue(credential.getClientExtensionResults()),
    ...(credential.authenticatorAttachment
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
  };
}

function authenticationCredentialToJSON(credential) {
  const response = credential.response;

  return {
    id: credential.id,
    rawId: bufferToBase64URL(credential.rawId),
    response: {
      authenticatorData: bufferToBase64URL(response.authenticatorData),
      clientDataJSON: bufferToBase64URL(response.clientDataJSON),
      signature: bufferToBase64URL(response.signature),
      userHandle: response.userHandle ? bufferToBase64URL(response.userHandle) : null,
    },
    type: credential.type,
    clientExtensionResults: serializeExtensionValue(credential.getClientExtensionResults()),
    ...(credential.authenticatorAttachment
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
  };
}

async function apiRequest(path, { method = "GET", body, authenticated = false } = {}) {
  const headers = { Accept: "application/json" };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (authenticated) {
    if (!state.accessToken) {
      throw new Error("Sign in to SendForge before enrolling ForgePass.");
    }
    headers.Authorization = `Bearer ${state.accessToken}`;
  }

  const response = await window.fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const contentType = response.headers.get("content-type") || "";
  let payload = null;
  if (response.status !== 204) {
    if (contentType.includes("application/json")) {
      payload = await response.json().catch(() => null);
    } else {
      await response.text().catch(() => "");
    }
  }

  if (!response.ok) {
    const error = new Error(
      payload?.error || payload?.message || `The server rejected this request (${response.status}).`,
    );
    error.status = response.status;
    throw error;
  }

  return payload || {};
}

function setReadinessValue(element, label, ready) {
  element.textContent = label;
  element.classList.toggle("is-ready", ready === true);
  element.classList.toggle("is-error", ready === false);
}

function setStatus(message, type = "success") {
  elements.statusMessage.textContent = message;
  elements.statusMessage.classList.toggle("is-error", type === "error");
  elements.statusMessage.setAttribute("role", type === "error" ? "alert" : "status");
  elements.statusMessage.hidden = false;
}

function clearStatus() {
  elements.statusMessage.hidden = true;
  elements.statusMessage.textContent = "";
  elements.statusMessage.classList.remove("is-error");
  elements.statusMessage.setAttribute("role", "status");
}

function stepState(step, complete, label) {
  step.classList.toggle("is-complete", complete);
  step.querySelector("[data-step-state]").textContent = label;
}

function renderBrowserReadiness() {
  setReadinessValue(
    elements.secureContextStatus,
    browser.secure ? "Secure" : "HTTPS required",
    browser.secure,
  );
  setReadinessValue(
    elements.webauthnStatus,
    browser.webauthn ? "Available" : "Unavailable",
    browser.webauthn,
  );

  const ready = browser.secure && browser.webauthn;
  elements.connectionPill.classList.toggle("is-ready", ready);
  elements.connectionPill.classList.toggle("is-error", !ready);
  elements.connectionLabel.textContent = ready ? "ForgePass ready" : "Browser not ready";

  if (!browser.secure) {
    setStatus("Open this page over HTTPS or localhost before starting a ForgePass ceremony.", "error");
  } else if (!browser.webauthn) {
    setStatus("This browser does not expose the WebAuthn API required by ForgePass.", "error");
  }
}

function renderSession() {
  const signedIn = Boolean(state.accessToken);
  setReadinessValue(elements.sessionStatus, signedIn ? "Active" : "Signed out", signedIn);
  elements.signOutButton.hidden = !signedIn;
  elements.enrollmentPassword.disabled = !signedIn || state.ceremonyActive;
  elements.enrollButton.disabled =
    !signedIn ||
    elements.enrollmentPassword.value.length < 8 ||
    !browser.secure ||
    !browser.webauthn ||
    state.ceremonyActive;
  elements.refreshButton.disabled = !signedIn || state.ceremonyActive;
  elements.passkeyLoginButton.disabled = !browser.secure || !browser.webauthn || state.ceremonyActive;

  const identity = state.user?.email || "";
  elements.sessionIdentity.textContent = identity ? `Signed in as ${identity}` : "";
  elements.sessionIdentity.hidden = !identity;

  stepState(elements.signInStep, signedIn, signedIn ? "Session active" : "Start here");
  stepState(
    elements.enrollStep,
    state.credentials.length > 0,
    state.credentials.length > 0 ? "Credential enrolled" : signedIn ? "Ready to enroll" : "Needs a session",
  );
  stepState(
    elements.passkeyStep,
    state.passkeyAuthenticated,
    state.passkeyAuthenticated ? "Passkey verified" : "Ready after enrollment",
  );
}

function clearSession() {
  state.accessToken = "";
  state.user = null;
  state.credentials = [];
  state.passkeyAuthenticated = false;
  clearSessionToken();
  elements.password.value = "";
  elements.enrollmentPassword.value = "";
  renderCredentials();
  renderSession();
}

function setSession(token, user = null, { viaPasskey = false } = {}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("The server did not return a usable session token.");
  }
  storeSessionToken(token);
  state.accessToken = token;
  state.user = user;
  state.passkeyAuthenticated = viaPasskey;
  renderSession();
}

function friendlyCeremonyError(error) {
  if (error?.message === "reauthentication_failed") {
    return "That SendForge password was not accepted. Enter the current account password and try again.";
  }
  if (error?.message === "credential_limit_reached") {
    return "This account already has the maximum number of enrolled credentials. Remove one before adding another.";
  }
  if (error?.message === "authenticator_not_allowed") {
    return "SendForge did not recognize this authenticator as ForgePass. If the browser asks to share authenticator information, allow it and try again.";
  }
  if (error?.message === "registration_failed") {
    return "ForgePass registration could not be verified. If the browser asks to share authenticator information, allow it and try again.";
  }
  if (error?.message === "authentication_failed") {
    return "ForgePass could not verify that sign-in. Make sure the authenticator is running and try again.";
  }
  if (error?.name === "NotAllowedError") {
    return "The ForgePass request was canceled or timed out. Make sure the authenticator is running and try again.";
  }
  if (error?.name === "InvalidStateError") {
    return "This ForgePass credential is already enrolled for the account.";
  }
  if (error?.name === "NotSupportedError") {
    return "The browser and authenticator could not agree on a supported credential type.";
  }
  if (error?.name === "SecurityError") {
    return "The WebAuthn origin or relying-party ID does not match this page. Check the server configuration.";
  }
  if (error?.name === "AbortError") {
    return "The ForgePass request was interrupted before it completed.";
  }
  return error?.message || "ForgePass could not complete the request.";
}

async function runCeremony(button, busyLabel, operation) {
  if (state.ceremonyActive) {
    return;
  }

  const label = button.querySelector("[data-button-label]");
  const originalLabel = label.textContent;
  state.ceremonyActive = true;
  button.setAttribute("aria-busy", "true");
  label.textContent = busyLabel;
  renderSession();
  clearStatus();

  try {
    await operation();
  } catch (error) {
    setStatus(friendlyCeremonyError(error), "error");
  } finally {
    state.ceremonyActive = false;
    button.removeAttribute("aria-busy");
    label.textContent = originalLabel;
    renderSession();
  }
}

function formatCredentialDate(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function credentialMeta(credential) {
  const details = [];
  const created = formatCredentialDate(credential.createdAt || credential.created_at);
  if (created) {
    details.push(`Enrolled ${created}`);
  }

  const deviceType = credential.deviceType || credential.device_type;
  if (deviceType) {
    details.push(String(deviceType).replaceAll("_", " "));
  }
  if (credential.backedUp === true || credential.backed_up === true) {
    details.push("backed up");
  }
  return details.join(" · ") || "Ready for passkey sign-in";
}

function renderCredentials() {
  elements.credentialList.replaceChildren();

  if (!state.accessToken) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Sign in to view your enrolled credentials.";
    elements.credentialList.append(empty);
    return;
  }

  if (state.credentials.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No ForgePass credentials are enrolled yet.";
    elements.credentialList.append(empty);
    return;
  }

  state.credentials.forEach((credential, index) => {
    const item = document.createElement("div");
    item.className = "credential-item";

    const text = document.createElement("div");
    const name = document.createElement("span");
    name.className = "credential-name";
    name.textContent = credential.name || credential.label || `ForgePass credential ${index + 1}`;
    const meta = document.createElement("span");
    meta.className = "credential-meta";
    meta.textContent = credentialMeta(credential);
    text.append(name, meta);

    const remove = document.createElement("button");
    remove.className = "remove-button";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${name.textContent}`);
    remove.addEventListener("click", () => removeCredential(credential));

    item.append(text, remove);
    elements.credentialList.append(item);
  });
}

async function loadCredentials({ quiet = false } = {}) {
  if (!state.accessToken) {
    state.credentials = [];
    renderCredentials();
    renderSession();
    return;
  }

  try {
    const payload = await apiRequest("/passkeys", { authenticated: true });
    state.credentials = Array.isArray(payload.credentials) ? payload.credentials : [];
    renderCredentials();
    renderSession();
    if (!quiet) {
      setStatus("Enrolled ForgePass credentials refreshed.");
    }
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      setStatus("Your SendForge session expired. Sign in again to manage ForgePass.", "error");
      return;
    }
    if (!quiet) {
      setStatus(error.message || "Could not load enrolled credentials.", "error");
    }
  }
}

async function removeCredential(credential) {
  if (!credential?.id) {
    setStatus("The server did not provide an ID for this credential.", "error");
    return;
  }

  const confirmed = window.confirm(
    "Remove this ForgePass credential? You will no longer be able to use it to sign in.",
  );
  if (!confirmed) {
    return;
  }

  clearStatus();
  try {
    await apiRequest(`/passkeys/${encodeURIComponent(credential.id)}`, {
      method: "DELETE",
      authenticated: true,
    });
    await loadCredentials({ quiet: true });
    setStatus("ForgePass credential removed.");
  } catch (error) {
    setStatus(error.message || "Could not remove the ForgePass credential.", "error");
  }
}

elements.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();

  const email = elements.email.value.trim();
  const password = elements.password.value;
  const originalLabel = elements.passwordSubmit.textContent;
  elements.passwordSubmit.disabled = true;
  elements.passwordSubmit.setAttribute("aria-busy", "true");
  elements.passwordSubmit.textContent = "Signing in…";

  try {
    const payload = await apiRequest("/login", {
      method: "POST",
      body: { email, password },
    });
    setSession(payload.token, payload.user || { email });
    elements.password.value = "";
    await loadCredentials({ quiet: true });
    setStatus("SendForge session active. You can now enroll ForgePass.");
  } catch (error) {
    setStatus(error.message || "SendForge sign-in failed.", "error");
  } finally {
    elements.passwordSubmit.disabled = false;
    elements.passwordSubmit.removeAttribute("aria-busy");
    elements.passwordSubmit.textContent = originalLabel;
  }
});

elements.enrollButton.addEventListener("click", () =>
  runCeremony(elements.enrollButton, "Waiting for ForgePass…", async () => {
    const password = elements.enrollmentPassword.value;
    let begin;
    try {
      begin = await apiRequest("/passkeys/register/options", {
        method: "POST",
        body: { password },
        authenticated: true,
      });
    } finally {
      elements.enrollmentPassword.value = "";
    }
    if (!begin.ceremonyId || !begin.options) {
      throw new Error("The server did not start a registration ceremony.");
    }

    const credential = await navigator.credentials.create({
      publicKey: prepareRegistrationOptions(begin.options),
    });
    if (!(credential instanceof PublicKeyCredential)) {
      throw new Error("The browser did not return a ForgePass credential.");
    }

    await apiRequest("/passkeys/register/verify", {
      method: "POST",
      body: {
        ceremonyId: begin.ceremonyId,
        response: registrationCredentialToJSON(credential),
      },
      authenticated: true,
    });

    await loadCredentials({ quiet: true });
    setStatus("ForgePass enrolled. Sign out when you are ready to test passwordless sign-in.");
  }),
);

elements.passkeyLoginButton.addEventListener("click", () =>
  runCeremony(elements.passkeyLoginButton, "Waiting for ForgePass…", async () => {
    const begin = await apiRequest("/passkeys/login/options", {
      method: "POST",
      body: {},
    });
    if (!begin.ceremonyId || !begin.options) {
      throw new Error("The server did not start an authentication ceremony.");
    }

    const credential = await navigator.credentials.get({
      publicKey: prepareAuthenticationOptions(begin.options),
    });
    if (!(credential instanceof PublicKeyCredential)) {
      throw new Error("The browser did not return a ForgePass assertion.");
    }

    const verified = await apiRequest("/passkeys/login/verify", {
      method: "POST",
      body: {
        ceremonyId: begin.ceremonyId,
        response: authenticationCredentialToJSON(credential),
      },
    });

    setSession(verified.token, verified.user || null, { viaPasskey: true });
    await loadCredentials({ quiet: true });
    setStatus("ForgePass verified. Passwordless SendForge sign-in is working end to end.");
  }),
);

elements.enrollmentPassword.addEventListener("input", renderSession);

elements.refreshButton.addEventListener("click", () => loadCredentials());

elements.signOutButton.addEventListener("click", () => {
  clearSession();
  setStatus("Signed out. Use step three to prove ForgePass-only authentication.");
});

renderBrowserReadiness();
renderCredentials();
renderSession();

if (state.accessToken) {
  loadCredentials({ quiet: true });
}
