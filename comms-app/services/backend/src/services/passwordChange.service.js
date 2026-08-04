import bcrypt from "bcrypt";

export const PASSWORD_HASH_COST = 12;
export const MAX_PASSWORD_BYTES = 72;

function validCurrentPassword(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 1024;
}

function validNewPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES
  );
}

export async function preparePasswordChange({
  currentPassword,
  newPassword,
  passwordHash,
  compare = bcrypt.compare,
  hash = bcrypt.hash,
}) {
  if (
    !validCurrentPassword(currentPassword) ||
    !validNewPassword(newPassword) ||
    typeof passwordHash !== "string" ||
    !passwordHash
  ) {
    return { error: "invalid_input" };
  }

  if (!(await compare(currentPassword, passwordHash))) {
    return { error: "current_password_incorrect" };
  }

  if (await compare(newPassword, passwordHash)) {
    return { error: "new_password_matches_current" };
  }

  return {
    passwordHash: await hash(newPassword, PASSWORD_HASH_COST),
  };
}
