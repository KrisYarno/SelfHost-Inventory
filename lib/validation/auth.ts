import { z } from 'zod';
import { usernameField } from '@/lib/validation/account';
import { strongPassword } from '@/lib/validation/admin';

/**
 * POST /api/auth/signup — public route.
 *
 * The schema covers structural validity: a present email (normalized to trimmed
 * lowercase), a well-formed username, and a strong password (reusing the same
 * rules as the admin password schemas). The allowed-email-domain restriction and
 * the email/username uniqueness check remain in the handler because they depend
 * on env config and the database respectively.
 *
 * `email` is intentionally not `.email()`-validated: a syntactically odd address
 * should still fall through to the handler's domain check (403), matching the
 * pre-schema behavior, rather than 400 here.
 */
export const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Missing required fields'),
  username: usernameField,
  password: strongPassword,
});

export type SignupInput = z.infer<typeof SignupSchema>;
