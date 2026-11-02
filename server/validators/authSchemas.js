'use strict';
// Request rules for registration and login (FR#1-FR#5).
// Error messages are shown to students next to the field, so they say how to fix it.
const { z } = require('zod');
const config = require('../config/env');
const {
  USERNAME_MIN,
  USERNAME_MAX,
  USERNAME_PATTERN,
  RESERVED_USERNAMES,
  PASSWORD_MAX_BYTES,
} = require('../constants/auth');
const { PASSWORD_MIN_LENGTH } = require('../constants/limits');
const authService = require('../services/authService');

const text = (label) =>
  z.string({
    error: (issue) =>
      issue.input === undefined ? `${label} is required` : `${label} must be text`,
  });

// TBD-1: when ALLOWED_EMAIL_DOMAINS is set, only those domains (and their subdomains) may register.
function emailDomainAllowed(email) {
  if (config.allowedEmailDomains.length === 0) return true;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return config.allowedEmailDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}
const domainMessage = () =>
  `Please use an email address from: ${config.allowedEmailDomains.join(', ')}`;

const registerSchema = z.object({
  email: text('Email')
    .trim()
    .toLowerCase()
    .min(1, 'Email is required')
    .max(254, 'Email is too long')
    .pipe(z.email('Enter a valid email address'))
    .refine(emailDomainAllowed, { error: domainMessage })
    .refine(async (email) => !(await authService.isEmailTaken(email)), {
      error: 'That email address is already registered',
    }),

  username: text('Username')
    .trim()
    .min(USERNAME_MIN, `Username must be at least ${USERNAME_MIN} characters`)
    .max(USERNAME_MAX, `Username must be ${USERNAME_MAX} characters or fewer`)
    .regex(USERNAME_PATTERN, 'Username can only contain letters, numbers and underscores')
    .refine((name) => !RESERVED_USERNAMES.includes(name.toLowerCase()), {
      error: 'That username is not available',
    })
    .refine(async (name) => !(await authService.isUsernameTaken(name)), {
      error: 'That username is already taken',
    }),

  // Passwords are never trimmed or changed.
  password: text('Password')
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .refine((pw) => /\p{L}/u.test(pw) && /\p{Nd}/u.test(pw), {
      error: 'Password must include at least one letter and one number',
    })
    .refine((pw) => Buffer.byteLength(pw, 'utf8') <= PASSWORD_MAX_BYTES, {
      error: `Password is too long (maximum ${PASSWORD_MAX_BYTES} characters)`,
    }),

  // FR#2: the Terms of Service must be accepted before an account is created.
  acceptTerms: z.literal(true, { error: 'You must accept the Terms of Service' }),
});

// Login only checks that something was sent. Anything else is answered with the same
// "invalid email or password" message (FR#5).
const loginSchema = z.object({
  email: text('Email').trim().min(1, 'Email is required').max(254, 'Email is too long'),
  password: text('Password').min(1, 'Password is required').max(200, 'Password is too long'),
});

module.exports = { registerSchema, loginSchema };
