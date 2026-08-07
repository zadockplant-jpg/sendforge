import crypto from "node:crypto";
import bcrypt from "bcrypt";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { db } from "../config/db.js";
import { env } from "../config/env.js";
import { issueCustomerAccessToken } from "./auth.service.js";

export const PASSKEY_REGISTRATION = "registration";
export const PASSKEY_AUTHENTICATION = "authentication";
export const FORGEPASS_AAGUID = "ccac9302f70b5904a2823658e8bca0a6";
export const PASSKEY_ALGORITHMS = Object.freeze([-7, -257]);
export const MAX_PASSKEYS_PER_USER = 10;

const VALID_TRANSPORTS = new Set([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

export class PasskeyError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "PasskeyError";
    this.code = code;
  }
}

function passkeyError(code, cause) {
  return new PasskeyError(code, cause ? { cause } : undefined);
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw passkeyError("invalid_timestamp");
  }
  return date;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeTransports(value) {
  const transports = parseJsonArray(value)
    .map((transport) => String(transport || "").trim().toLowerCase())
    .filter((transport) => VALID_TRANSPORTS.has(transport));
  return [...new Set(transports)].slice(0, 8);
}

export function normalizeAaguid(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "");
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : "";
}

export function userHandleForUserId(userId) {
  const value = String(userId || "");
  if (!value || Buffer.byteLength(value, "utf8") > 64) {
    throw passkeyError("invalid_user_handle");
  }
  return Buffer.from(value, "utf8").toString("base64url");
}

export function publicKeyBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value)) {
    return new Uint8Array(Buffer.from(value, "base64url"));
  }
  throw passkeyError("invalid_credential_public_key");
}

export function safeCounter(value) {
  const counter = Number(value);
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw passkeyError("invalid_credential_counter");
  }
  return counter;
}

function challengeRow(rows) {
  if (Array.isArray(rows)) return rows[0] || null;
  return rows || null;
}

export function createPasskeyRepository(database = db) {
  return {
    async listCredentialsForOptions(userId) {
      return database("webauthn_credentials")
        .select("credential_id", "transports")
        .where({ user_id: userId })
        .orderBy("created_at", "asc");
    },

    async createCeremony({ id, userId, purpose, challenge, expiresAt, now }) {
      await database("webauthn_challenges")
        .where("expires_at", "<=", now)
        .del();
      await database("webauthn_challenges").insert({
        id,
        user_id: userId || null,
        purpose,
        challenge,
        expires_at: expiresAt,
        created_at: now,
      });
    },

    async consumeCeremony({ id, userId, purpose, now }) {
      let query = database("webauthn_challenges").where({ id, purpose });
      if (userId) query = query.andWhere({ user_id: userId });
      const rows = await query
        .del()
        .returning(["challenge", "expires_at", "user_id"]);
      const row = challengeRow(rows);
      if (!row || asDate(row.expires_at).getTime() <= now.getTime()) {
        return null;
      }
      return row;
    },

    async getVerifiedUser(userId) {
      return database("users")
        .select(
          "id",
          "email",
          "password_hash",
          "email_verified",
          "auth_version"
        )
        .where({ id: userId, email_verified: true })
        .first();
    },

    async insertCredential(credential) {
      return database.transaction(async (transaction) => {
        await transaction("users")
          .select("id")
          .where({ id: credential.user_id })
          .forUpdate()
          .first();
        const countRow = await transaction("webauthn_credentials")
          .where({ user_id: credential.user_id })
          .count("id as count")
          .first();
        if (Number(countRow?.count || 0) >= MAX_PASSKEYS_PER_USER) {
          return false;
        }
        await transaction("webauthn_credentials").insert(credential);
        return true;
      });
    },

    async withLockedCredential(credentialId, operation) {
      return database.transaction(async (transaction) => {
        const row = await transaction("webauthn_credentials as credential")
          .join("users as user", "user.id", "credential.user_id")
          .select(
            "credential.id as record_id",
            "credential.user_id",
            "credential.credential_id",
            "credential.public_key",
            "credential.counter",
            "credential.transports",
            "credential.user_handle",
            "credential.aaguid",
            "credential.device_type",
            "credential.backed_up",
            "user.email",
            "user.email_verified",
            "user.auth_version"
          )
          .where("credential.credential_id", credentialId)
          .forUpdate()
          .first();

        if (!row) return null;
        return operation({
          row,
          async update(values) {
            await transaction("webauthn_credentials")
              .where({ id: row.record_id })
              .update(values);
          },
        });
      });
    },

    async listCredentials(userId) {
      return database("webauthn_credentials")
        .select(
          "id",
          "name",
          "aaguid",
          "device_type",
          "backed_up",
          "transports",
          "created_at",
          "last_used_at"
        )
        .where({ user_id: userId })
        .orderBy("created_at", "asc");
    },

    async deleteCredential(userId, id) {
      return database("webauthn_credentials")
        .where({ id, user_id: userId })
        .del();
    },
  };
}

function publicCredential(row) {
  return {
    id: row.id,
    name: row.name || "ForgePass",
    aaguid: normalizeAaguid(row.aaguid) || null,
    deviceType: row.device_type || "singleDevice",
    backedUp: Boolean(row.backed_up),
    transports: normalizeTransports(row.transports),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
  };
}

export function createPasskeyService({
  repository = createPasskeyRepository(),
  configuration = env,
  registrationOptions = generateRegistrationOptions,
  registrationVerifier = verifyRegistrationResponse,
  authenticationOptions = generateAuthenticationOptions,
  authenticationVerifier = verifyAuthenticationResponse,
  passwordVerifier = bcrypt.compare,
  tokenIssuer = issueCustomerAccessToken,
  randomUUID = crypto.randomUUID,
  clock = () => new Date(),
} = {}) {
  const now = () => asDate(clock());

  async function createCeremony({ userId = null, purpose, challenge }) {
    const createdAt = now();
    const ceremonyId = randomUUID();
    const expiresAt = new Date(
      createdAt.getTime() + configuration.webAuthnChallengeTtlMs
    );
    await repository.createCeremony({
      id: ceremonyId,
      userId,
      purpose,
      challenge,
      expiresAt,
      now: createdAt,
    });
    return ceremonyId;
  }

  async function consumeCeremony({ ceremonyId, userId = null, purpose }) {
    const ceremony = await repository.consumeCeremony({
      id: ceremonyId,
      userId,
      purpose,
      now: now(),
    });
    if (!ceremony) throw passkeyError("invalid_or_expired_ceremony");
    return ceremony;
  }

  return {
    async registrationOptions({ userId, password }) {
      const user = await repository.getVerifiedUser(userId);
      let passwordAccepted = false;
      try {
        passwordAccepted = Boolean(
          user &&
            (await passwordVerifier(password, user.password_hash))
        );
      } catch {
        passwordAccepted = false;
      }
      if (!passwordAccepted) {
        throw passkeyError("reauthentication_failed");
      }

      const existingCredentials = await repository.listCredentialsForOptions(
        userId
      );
      if (existingCredentials.length >= MAX_PASSKEYS_PER_USER) {
        throw passkeyError("credential_limit_reached");
      }
      const userID = new Uint8Array(Buffer.from(String(userId), "utf8"));
      const options = await registrationOptions({
        rpName: configuration.webAuthnRpName,
        rpID: configuration.webAuthnRpId,
        userName: user.email,
        userDisplayName: user.email,
        userID,
        // Chrome erases the AAGUID from cross-platform authenticators when the
        // RP requests no attestation. ForgePass currently returns fmt "none",
        // but requesting direct conveyance preserves its AAGUID for the
        // compatibility allowlist below.
        attestationType: "direct",
        excludeCredentials: existingCredentials.map((credential) => ({
          id: credential.credential_id,
          transports: normalizeTransports(credential.transports),
        })),
        authenticatorSelection: {
          authenticatorAttachment: "cross-platform",
          residentKey: "required",
          userVerification: "required",
        },
        preferredAuthenticatorType: "securityKey",
        supportedAlgorithmIDs: PASSKEY_ALGORITHMS,
        timeout: configuration.webAuthnTimeoutMs,
      });
      const ceremonyId = await createCeremony({
        userId,
        purpose: PASSKEY_REGISTRATION,
        challenge: options.challenge,
      });
      return { ceremonyId, options };
    },

    async verifyRegistration({ userId, ceremonyId, response }) {
      const ceremony = await consumeCeremony({
        ceremonyId,
        userId,
        purpose: PASSKEY_REGISTRATION,
      });

      const user = await repository.getVerifiedUser(userId);
      if (!user) throw passkeyError("registration_failed");

      let verification;
      try {
        verification = await registrationVerifier({
          response,
          expectedChallenge: ceremony.challenge,
          expectedOrigin: configuration.webAuthnOrigins,
          expectedRPID: configuration.webAuthnRpId,
          requireUserPresence: true,
          requireUserVerification: true,
          supportedAlgorithmIDs: PASSKEY_ALGORITHMS,
        });
      } catch (error) {
        throw passkeyError("registration_failed", error);
      }

      if (!verification?.verified || !verification.registrationInfo) {
        throw passkeyError("registration_failed");
      }

      const { registrationInfo } = verification;
      const aaguid = normalizeAaguid(registrationInfo.aaguid);
      const allowedAaguids = configuration.webAuthnAllowedAaguids || [];
      if (allowedAaguids.length > 0 && !allowedAaguids.includes(aaguid)) {
        throw passkeyError("authenticator_not_allowed");
      }

      const transports = normalizeTransports(response.response?.transports);
      const createdAt = now();
      const id = randomUUID();
      try {
        const inserted = await repository.insertCredential({
          id,
          user_id: userId,
          credential_id: registrationInfo.credential.id,
          public_key: Buffer.from(registrationInfo.credential.publicKey),
          counter: String(safeCounter(registrationInfo.credential.counter)),
          transports: JSON.stringify(transports),
          user_handle: userHandleForUserId(userId),
          aaguid: aaguid || null,
          device_type: registrationInfo.credentialDeviceType,
          backed_up: Boolean(registrationInfo.credentialBackedUp),
          name: "ForgePass",
          created_at: createdAt,
          updated_at: createdAt,
          last_used_at: null,
        });
        if (inserted === false) {
          throw passkeyError("credential_limit_reached");
        }
      } catch (error) {
        if (error instanceof PasskeyError) throw error;
        if (error?.code === "23505") {
          throw passkeyError("credential_already_registered", error);
        }
        throw passkeyError("registration_failed", error);
      }

      return {
        ok: true,
        credential: publicCredential({
          id,
          name: "ForgePass",
          aaguid,
          device_type: registrationInfo.credentialDeviceType,
          backed_up: registrationInfo.credentialBackedUp,
          transports,
          created_at: createdAt,
          last_used_at: null,
        }),
      };
    },

    async authenticationOptions() {
      const options = await authenticationOptions({
        rpID: configuration.webAuthnRpId,
        userVerification: "required",
        timeout: configuration.webAuthnTimeoutMs,
      });
      const ceremonyId = await createCeremony({
        purpose: PASSKEY_AUTHENTICATION,
        challenge: options.challenge,
      });
      return { ceremonyId, options };
    },

    async verifyAuthentication({ ceremonyId, response }) {
      const ceremony = await consumeCeremony({
        ceremonyId,
        purpose: PASSKEY_AUTHENTICATION,
      });

      let result;
      try {
        result = await repository.withLockedCredential(
          response.id,
          async ({ row, update }) => {
            if (!row.email_verified) throw passkeyError("authentication_failed");
            if (
              !response.response?.userHandle ||
              response.response.userHandle !== row.user_handle
            ) {
              throw passkeyError("authentication_failed");
            }

            const verification = await authenticationVerifier({
              response,
              expectedChallenge: ceremony.challenge,
              expectedOrigin: configuration.webAuthnOrigins,
              expectedRPID: configuration.webAuthnRpId,
              credential: {
                id: row.credential_id,
                publicKey: publicKeyBytes(row.public_key),
                counter: safeCounter(row.counter),
                transports: normalizeTransports(row.transports),
              },
              requireUserVerification: true,
            });
            if (!verification?.verified) {
              throw passkeyError("authentication_failed");
            }

            const usedAt = now();
            await update({
              counter: String(
                safeCounter(verification.authenticationInfo.newCounter)
              ),
              device_type: verification.authenticationInfo.credentialDeviceType,
              backed_up: Boolean(
                verification.authenticationInfo.credentialBackedUp
              ),
              last_used_at: usedAt,
              updated_at: usedAt,
            });

            const token = tokenIssuer({
              id: row.user_id,
              email: row.email,
              authVersion: row.auth_version || 0,
            });
            return {
              token,
              user: { id: row.user_id, email: row.email },
              credential: {
                id: row.record_id,
                name: "ForgePass",
                aaguid: normalizeAaguid(row.aaguid) || null,
              },
            };
          }
        );
      } catch (error) {
        if (error instanceof PasskeyError) throw error;
        throw passkeyError("authentication_failed", error);
      }

      if (!result) throw passkeyError("authentication_failed");
      return result;
    },

    async listCredentials(userId) {
      const rows = await repository.listCredentials(userId);
      return rows.map(publicCredential);
    },

    async deleteCredential(userId, id) {
      const deleted = await repository.deleteCredential(userId, id);
      if (!deleted) throw passkeyError("credential_not_found");
      return { ok: true };
    },
  };
}

export const passkeyService = createPasskeyService();
