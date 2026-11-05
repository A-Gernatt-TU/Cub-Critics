'use strict';
// Request rules for moderation (FR#41-FR#44).
const { z } = require('zod');
const { safeText, queryEnum, queryInteger } = require('./common');

const REASON_MAX = 500;

// Approving or flagging may carry a note; removing requires a reason (FR#44).
const optionalNote = safeText('Reason', { max: REASON_MAX, multiline: true })
  .nullish()
  .transform((text) => text || null);

const noteSchema = z.object({ reason: optionalNote });
const removeSchema = z.object({
  reason: safeText('Reason', { min: 1, max: REASON_MAX, multiline: true }),
});

// GET /api/admin/moderation/queue
const queueQuerySchema = z.object({
  status: queryEnum('Status', ['reported', 'flagged']),
  limit: queryInteger('Limit', { min: 1, max: 50 }),
  offset: queryInteger('Offset', { min: 0, max: 100000 }),
});

module.exports = { noteSchema, removeSchema, queueQuerySchema };
