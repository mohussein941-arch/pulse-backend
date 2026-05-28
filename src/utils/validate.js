// utils/validate.js — zod schemas and validation middleware for all routes

const { z } = require('zod');

// ── Reusable primitives ───────────────────────────────────────────────────────
const uuid    = z.string().uuid('Must be a valid UUID');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').nullable().optional();
const priority = z.enum(['Low', 'Medium', 'High', 'Critical']);

// ── Schemas ───────────────────────────────────────────────────────────────────
const schemas = {

  taskCreate: z.object({
    title:       z.string().min(1, 'title is required').max(255).trim(),
    description: z.string().max(2000).optional().default(''),
    priority:    priority.optional().default('High'),
    dueDate:     dateStr,
    accountId:   uuid.nullable().optional(),
  }),

  taskUpdate: z.object({
    done:        z.boolean().optional(),
    title:       z.string().min(1).max(255).trim().optional(),
    description: z.string().max(2000).optional(),
    priority:    priority.optional(),
    dueDate:     dateStr,
  }).refine(body => Object.keys(body).length > 0, { message: 'No update fields provided' }),

  briefingItemUpdate: z.object({
    status:    z.enum(['done', 'snoozed', 'dismissed', 'pending']),
    snoozeDays: z.number().int().min(1).max(90).optional(),
  }).refine(
    data => data.status !== 'snoozed' || data.snoozeDays != null,
    { message: 'snoozeDays required when status is snoozed' }
  ),

  briefingSettings: z.object({
    enabled:       z.boolean().optional(),
    days:          z.array(z.number().int().min(0).max(6)).max(7).optional(),
    hour:          z.number().int().min(0).max(23).optional(),
    timezone:      z.string().max(60).optional(),
    email_enabled: z.boolean().optional(),
  }),

  emailSend: z.object({
    accountId: uuid,
    to:        z.array(z.string().email()).min(1).max(50),
    subject:   z.string().min(1).max(500).trim(),
    htmlBody:  z.string().min(1).max(200_000),
    surveyId:  uuid.optional(),
  }),

  aiConfig: z.object({
    provider: z.enum(['anthropic', 'openai']),
    api_key:  z.string().min(10).max(200),
    model:    z.string().max(100).optional(),
  }),

  csmProfileUpdate: z.object({
    career_stage:  z.enum(['junior', 'mid', 'senior', 'lead']).optional(),
    specialty:     z.enum(['general_csm', 'technical_csm', 'enterprise_csm', 'growth_csm']).optional(),
    // working_style must be a plain JSON object — not an array, not a primitive
    working_style: z.object({}).passthrough().optional(),
  }).refine(
    body => Object.keys(body).length > 0,
    { message: 'At least one of career_stage, specialty, or working_style is required' }
  ),
};

// ── Middleware factory ────────────────────────────────────────────────────────
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error:   'Validation failed',
        details: result.error.errors.map(e => `${e.path.join('.') || 'body'}: ${e.message}`),
      });
    }
    req.body = result.data;
    next();
  };
}

// ── Param validator — UUID path params ───────────────────────────────────────
function validateUuidParam(paramName) {
  return (req, res, next) => {
    const result = uuid.safeParse(req.params[paramName]);
    if (!result.success) {
      return res.status(400).json({ error: `Invalid ${paramName}: must be a UUID` });
    }
    next();
  };
}

module.exports = { schemas, validate, validateUuidParam };
