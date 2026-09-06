import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export const DEFAULT_FORGEPASS_AAGUID = "ccac9302f70b5904a2823658e8bca0a6";
export const DEFAULT_WEBAUTHN_TIMEOUT_MS = 60_000;
export const DEFAULT_WEBAUTHN_CHALLENGE_TTL_SECONDS = 300;

const MIN_WEBAUTHN_TIMEOUT_MS = 15_000;
const MAX_WEBAUTHN_TIMEOUT_MS = 300_000;

function productionValue(values, name, nodeEnv) {
  const value = String(values[name] || "").trim();

  if (!value && nodeEnv === "production") {
    throw new Error(`${name} must be set in production`);
  }

  return value;
}

function parseRpName(values, nodeEnv) {
  const name =
    productionValue(values, "WEBAUTHN_RP_NAME", nodeEnv) || "ForgePass";

  if (name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error(
      "WEBAUTHN_RP_NAME must be between 1 and 128 printable characters"
    );
  }

  return name;
}

function parseRpId(values, nodeEnv) {
  const configured = productionValue(values, "WEBAUTHN_RP_ID", nodeEnv);
  const candidate = (configured || "localhost").toLowerCase();

  if (
    candidate.includes("://") ||
    candidate.includes(":") ||
    candidate.includes("/") ||
    candidate.startsWith(".") ||
    candidate.endsWith(".")
  ) {
    throw new Error(
      "WEBAUTHN_RP_ID must be a hostname without a scheme, port, or path"
    );
  }

  const rpId = domainToASCII(candidate);
  const labels = rpId.split(".");
  const validHostname =
    Boolean(rpId) &&
    rpId.length <= 253 &&
    labels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    );

  if (!validHostname) {
    throw new Error("WEBAUTHN_RP_ID must be a valid hostname");
  }

  if (
    nodeEnv === "production" &&
    (rpId === "localhost" || isIP(rpId) !== 0 || !rpId.includes("."))
  ) {
    throw new Error("WEBAUTHN_RP_ID must be a production domain name");
  }

  return rpId;
}

function originBelongsToRp(originHostname, rpId) {
  return originHostname === rpId || originHostname.endsWith(`.${rpId}`);
}

function parseOrigins(values, { nodeEnv, port, rpId }) {
  const configured = productionValue(values, "WEBAUTHN_ORIGINS", nodeEnv);
  const rawOrigins = configured || `http://localhost:${port}`;
  const candidates = rawOrigins.split(",").map((value) => value.trim());

  if (
    candidates.length === 0 ||
    candidates.length > 16 ||
    candidates.some((value) => !value)
  ) {
    throw new Error(
      "WEBAUTHN_ORIGINS must contain between 1 and 16 comma-separated origins"
    );
  }

  const origins = candidates.map((candidate) => {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error(`Invalid WebAuthn origin: ${candidate}`);
    }

    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin === "null"
    ) {
      throw new Error(
        `WebAuthn origins cannot contain credentials, paths, queries, or fragments: ${candidate}`
      );
    }

    const isLocalDevelopmentOrigin =
      nodeEnv !== "production" &&
      url.protocol === "http:" &&
      url.hostname === "localhost";

    if (url.protocol !== "https:" && !isLocalDevelopmentOrigin) {
      throw new Error(
        `WebAuthn origins must use HTTPS (HTTP is allowed only for local development): ${candidate}`
      );
    }

    if (!originBelongsToRp(url.hostname, rpId)) {
      throw new Error(
        `WebAuthn origin hostname ${url.hostname} is outside RP ID ${rpId}`
      );
    }

    return url.origin;
  });

  return Object.freeze([...new Set(origins)]);
}

function parseTimeout(values) {
  const raw = String(
    values.WEBAUTHN_TIMEOUT_MS || DEFAULT_WEBAUTHN_TIMEOUT_MS
  ).trim();
  const timeoutMs = Number(raw);

  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_WEBAUTHN_TIMEOUT_MS ||
    timeoutMs > MAX_WEBAUTHN_TIMEOUT_MS
  ) {
    throw new Error(
      `WEBAUTHN_TIMEOUT_MS must be an integer from ${MIN_WEBAUTHN_TIMEOUT_MS} to ${MAX_WEBAUTHN_TIMEOUT_MS}`
    );
  }

  return timeoutMs;
}

function parseChallengeTtlMs(values) {
  const raw = String(
    values.WEBAUTHN_CHALLENGE_TTL_SECONDS ||
      DEFAULT_WEBAUTHN_CHALLENGE_TTL_SECONDS
  ).trim();
  const ttlSeconds = Number(raw);

  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 600
  ) {
    throw new Error(
      "WEBAUTHN_CHALLENGE_TTL_SECONDS must be an integer from 60 to 600"
    );
  }

  return ttlSeconds * 1_000;
}

function normalizeAaguid(value) {
  const token = value.trim().toLowerCase();

  if (
    !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.test(
      token
    )
  ) {
    throw new Error(`Invalid ForgePass AAGUID: ${value}`);
  }

  return token.replaceAll("-", "");
}

function parseAllowedAaguids(values, nodeEnv) {
  const configured = productionValue(
    values,
    "WEBAUTHN_ALLOWED_AAGUIDS",
    nodeEnv
  );
  const raw = configured || DEFAULT_FORGEPASS_AAGUID;
  const candidates = raw.split(",").map((value) => value.trim());

  if (
    candidates.length === 0 ||
    candidates.length > 32 ||
    candidates.some((value) => !value)
  ) {
    throw new Error(
      "WEBAUTHN_ALLOWED_AAGUIDS must contain between 1 and 32 comma-separated AAGUIDs"
    );
  }

  return Object.freeze([...new Set(candidates.map(normalizeAaguid))]);
}

export function buildWebAuthnConfig({ values = process.env, nodeEnv, port } = {}) {
  const effectiveNodeEnv = nodeEnv || values.NODE_ENV || "development";
  const effectivePort = Number(port ?? values.PORT ?? 3000);

  if (
    !Number.isSafeInteger(effectivePort) ||
    effectivePort < 1 ||
    effectivePort > 65_535
  ) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }

  const rpId = parseRpId(values, effectiveNodeEnv);

  return Object.freeze({
    rpName: parseRpName(values, effectiveNodeEnv),
    rpId,
    origins: parseOrigins(values, {
      nodeEnv: effectiveNodeEnv,
      port: effectivePort,
      rpId,
    }),
    timeoutMs: parseTimeout(values),
    challengeTtlMs: parseChallengeTtlMs(values),
    allowedAaguids: parseAllowedAaguids(values, effectiveNodeEnv),
  });
}
