export function validate(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
    req.validatedBody = parsed.data;
    next();
  };
}
