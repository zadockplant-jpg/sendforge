import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import {
  createRateLimiter,
  rateLimitByIp,
  rateLimitByUserOrIp,
} from "../middleware/rateLimit.js";
import {
  PasskeyError,
  passkeyService,
} from "../services/passkey.service.js";
import { getRequestId, log } from "../utils/logger.js";

const Base64Url = (maximum) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[A-Za-z0-9_-]+$/u);

const ClientExtensionResults = z
  .record(z.unknown())
  .refine((value) => JSON.stringify(value).length <= 8_192);

const RegistrationResponse = z
  .object({
    id: Base64Url(2_048),
    rawId: Base64Url(2_048),
    type: z.literal("public-key"),
    response: z.object({
      clientDataJSON: Base64Url(32_768),
      attestationObject: Base64Url(1_048_576),
      transports: z
        .array(
          z.enum([
            "ble",
            "cable",
            "hybrid",
            "internal",
            "nfc",
            "smart-card",
            "usb",
          ])
        )
        .max(8)
        .optional(),
    }),
    clientExtensionResults: ClientExtensionResults.optional().default({}),
    authenticatorAttachment: z
      .enum(["cross-platform", "platform"])
      .nullable()
      .optional(),
  })
  .strict()
  .refine((credential) => credential.id === credential.rawId, {
    message: "credential id mismatch",
  });

const AuthenticationResponse = z
  .object({
    id: Base64Url(2_048),
    rawId: Base64Url(2_048),
    type: z.literal("public-key"),
    response: z.object({
      clientDataJSON: Base64Url(32_768),
      authenticatorData: Base64Url(8_192),
      signature: Base64Url(8_192),
      userHandle: Base64Url(1_024).optional(),
    }),
    clientExtensionResults: ClientExtensionResults.optional().default({}),
    authenticatorAttachment: z
      .enum(["cross-platform", "platform"])
      .nullable()
      .optional(),
  })
  .strict()
  .refine((credential) => credential.id === credential.rawId, {
    message: "credential id mismatch",
  });

const Ceremony = z
  .object({
    ceremonyId: z.string().uuid(),
    response: z.unknown(),
  })
  .strict();

const EmptyBody = z.object({}).strict();
const RegistrationOptionsBody = z
  .object({
    password: z.string().min(8).max(256),
  })
  .strict();

function passkeyFailure(error, operation, req, res) {
  const requestId = getRequestId(req);
  const errorCode = error instanceof PasskeyError ? error.code : "server_error";
  const internalFailure = !(error instanceof PasskeyError);

  log(internalFailure ? "error" : "warn", `passkey_${operation}_failed`, {
    requestId,
    userId: req.user?.sub || null,
    code: errorCode,
    cause: error?.cause?.name || null,
  });

  if (internalFailure) {
    return res.status(500).json({ error: "server_error" });
  }
  if (errorCode === "reauthentication_failed") {
    return res.status(403).json({ error: "reauthentication_failed" });
  }
  if (errorCode === "credential_limit_reached") {
    return res.status(409).json({ error: "credential_limit_reached" });
  }
  if (errorCode === "authenticator_not_allowed") {
    return res.status(400).json({ error: "authenticator_not_allowed" });
  }
  if (operation.startsWith("registration")) {
    return res.status(400).json({ error: "registration_failed" });
  }
  if (operation.startsWith("authentication")) {
    return res.status(400).json({ error: "authentication_failed" });
  }
  if (errorCode === "credential_not_found") {
    return res.status(404).json({ error: "credential_not_found" });
  }
  return res.status(500).json({ error: "server_error" });
}

function invalidInput(res) {
  return res.status(400).json({ error: "invalid_input" });
}

export function createPasskeyRouter({
  service = passkeyService,
  authMiddleware = requireAuth,
} = {}) {
  const router = Router();

  const registrationOptionsLimiter = createRateLimiter({
    name: "passkey-registration-options",
    windowMs: 5 * 60 * 1_000,
    max: 10,
    keyGenerator: rateLimitByUserOrIp,
    message: "too_many_passkey_registration_attempts",
  });
  const registrationVerifyLimiter = createRateLimiter({
    name: "passkey-registration-verify",
    windowMs: 5 * 60 * 1_000,
    max: 10,
    keyGenerator: rateLimitByUserOrIp,
    message: "too_many_passkey_registration_attempts",
  });
  const authenticationOptionsLimiter = createRateLimiter({
    name: "passkey-authentication-options",
    windowMs: 60 * 1_000,
    max: 60,
    keyGenerator: rateLimitByIp,
    message: "too_many_passkey_authentication_attempts",
  });
  const authenticationVerifyLimiter = createRateLimiter({
    name: "passkey-authentication-verify",
    windowMs: 5 * 60 * 1_000,
    max: 60,
    keyGenerator: rateLimitByIp,
    message: "too_many_passkey_authentication_attempts",
  });
  const managementLimiter = createRateLimiter({
    name: "passkey-management",
    windowMs: 60 * 1_000,
    max: 30,
    keyGenerator: rateLimitByUserOrIp,
    message: "too_many_passkey_management_requests",
  });

  router.get("/status", (_req, res) => {
    return res.json({
      ok: true,
      rpId: env.webAuthnRpId,
      rpName: env.webAuthnRpName,
      origins: env.webAuthnOrigins,
    });
  });

  router.post(
    "/register/options",
    authMiddleware,
    registrationOptionsLimiter,
    async (req, res) => {
      const parsed = RegistrationOptionsBody.safeParse(req.body);
      if (!parsed.success) return invalidInput(res);
      try {
        const result = await service.registrationOptions({
          userId: req.user.sub,
          password: parsed.data.password,
        });
        return res.json(result);
      } catch (error) {
        return passkeyFailure(error, "registration_options", req, res);
      }
    }
  );

  router.post(
    "/register/verify",
    authMiddleware,
    registrationVerifyLimiter,
    async (req, res) => {
      const envelope = Ceremony.safeParse(req.body);
      if (!envelope.success) return invalidInput(res);
      const response = RegistrationResponse.safeParse(envelope.data.response);
      if (!response.success) return invalidInput(res);

      try {
        const result = await service.verifyRegistration({
          userId: req.user.sub,
          ceremonyId: envelope.data.ceremonyId,
          response: response.data,
        });
        return res.status(201).json(result);
      } catch (error) {
        return passkeyFailure(error, "registration_verify", req, res);
      }
    }
  );

  router.post(
    "/login/options",
    authenticationOptionsLimiter,
    async (req, res) => {
      if (!EmptyBody.safeParse(req.body || {}).success) return invalidInput(res);
      try {
        const result = await service.authenticationOptions();
        return res.json(result);
      } catch (error) {
        return passkeyFailure(error, "authentication_options", req, res);
      }
    }
  );

  router.post(
    "/login/verify",
    authenticationVerifyLimiter,
    async (req, res) => {
      const envelope = Ceremony.safeParse(req.body);
      if (!envelope.success) return invalidInput(res);
      const response = AuthenticationResponse.safeParse(envelope.data.response);
      if (!response.success) return invalidInput(res);

      try {
        const result = await service.verifyAuthentication({
          ceremonyId: envelope.data.ceremonyId,
          response: response.data,
        });
        return res.json(result);
      } catch (error) {
        return passkeyFailure(error, "authentication_verify", req, res);
      }
    }
  );

  router.get("/", authMiddleware, managementLimiter, async (req, res) => {
    try {
      const credentials = await service.listCredentials(req.user.sub);
      return res.json({ credentials });
    } catch (error) {
      return passkeyFailure(error, "management_list", req, res);
    }
  });

  router.delete(
    "/:id",
    authMiddleware,
    managementLimiter,
    async (req, res) => {
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) return invalidInput(res);
      try {
        const result = await service.deleteCredential(req.user.sub, id.data);
        return res.json(result);
      } catch (error) {
        return passkeyFailure(error, "management_delete", req, res);
      }
    }
  );

  return router;
}

export const passkeyRouter = createPasskeyRouter();
