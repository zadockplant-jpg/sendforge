import { z } from "zod";
import { GEM_COLORS } from "./engine.js";

const clean = (max, min = 0) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => value.length >= min, min ? `Enter at least ${min} character${min === 1 ? "" : "s"}.` : undefined)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Use a single line.");

const multiline = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Remove unsupported characters.");

const uuid = z.string().uuid();
const icon = z.string().regex(/^[a-z0-9-]{1,40}$/);
const color = z.enum(GEM_COLORS);

export const KINDS = ["couple", "friends", "family", "team"];
export const ROLES = ["keeper", "seeker", "both"];
export const RECURRENCE = ["once", "daily", "weekly", "always"];

export const timezoneSchema = z
  .string()
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone.");

export const createCircleSchema = z
  .object({
    name: clean(60, 1),
    kind: z.enum(KINDS),
    displayName: clean(32, 1),
    // Whoever starts a circle keeps it: keeper, or keeper and seeker.
    role: z.enum(["keeper", "both"]).optional(),
    timezone: timezoneSchema.optional(),
    avatar: icon.optional(),
    color: color.optional(),
  })
  .strict();

export const joinCircleSchema = z
  .object({
    inviteCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{6,12}$/, "Check the invite code."),
    displayName: clean(32, 1),
    avatar: icon.optional(),
    color: color.optional(),
  })
  .strict();

export const updateCircleSchema = z
  .object({ name: clean(60, 1).optional(), timezone: timezoneSchema.optional() })
  .strict();

export const addMemberSchema = z
  .object({ displayName: clean(32, 1), avatar: icon.optional(), color: color.optional() })
  .strict();

export const updateMemberSchema = z
  .object({
    displayName: clean(32, 1).optional(),
    avatar: icon.optional(),
    color: color.optional(),
    role: z.enum(ROLES).optional(),
  })
  .strict();

export const questSchema = z
  .object({
    title: clean(80, 1),
    description: multiline(500).optional().default(""),
    icon: icon.optional().default("star"),
    points: z.number().int().min(0).max(100_000),
    keyPathId: uuid.nullable().optional().default(null),
    recurrence: z.enum(RECURRENCE).default("once"),
    assigneeIds: z.array(uuid).max(30).default([]),
    requiresApproval: z.boolean().default(true),
  })
  .strict();

export const questPatchSchema = questSchema.partial().strict();

export const claimSchema = z.object({ note: multiline(280).optional().default("") }).strict();

export const decideSchema = z
  .object({ approve: z.boolean(), note: multiline(280).optional().default("") })
  .strict();

export const giftSchema = z
  .object({
    memberId: uuid,
    stones: z.number().int().min(-10_000).max(10_000).optional().default(0),
    pathId: uuid.nullable().optional().default(null),
    note: clean(200).optional().default(""),
  })
  .strict()
  .refine((value) => value.stones !== 0 || value.pathId, "Give stones, a key, or both.");

export const pathSchema = z
  .object({
    title: clean(80, 1),
    teaser: multiline(200).optional().default(""),
    icon: icon.optional().default("gem"),
    color: color.optional().default("violet"),
    cost: z.number().int().min(0).max(100_000).nullable(),
    repeatable: z.boolean().default(false),
    assigneeIds: z.array(uuid).max(30).default([]),
    graph: z.record(z.any()),
  })
  .strict();

export const pathPatchSchema = pathSchema.partial().strict();

export const openPathSchema = z.object({ payWith: z.enum(["key", "stones", "free"]) }).strict();

export const stepSchema = z
  .object({
    nodeId: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/),
    optionId: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional().default("spin"),
  })
  .strict();

export const fulfillSchema = z
  .object({ status: z.enum(["scheduled", "delivered"]), note: multiline(280).optional().default("") })
  .strict();

export function issues(error) {
  return (error?.issues || []).slice(0, 5).map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}
