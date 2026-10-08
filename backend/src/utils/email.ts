import { EmailService } from "../services/email.service";

/**
 * Sends a password reset email to the specified recipient.
 *
 * @param to - The recipient's email address
 * @param token - The raw, unhashed password reset token (not its hash)
 * @returns A promise that resolves when the email is sent
 */
export async function sendPasswordResetEmail(
  to: string,
  token: string,
): Promise<void> {
  await EmailService.sendPasswordResetEmail(to, token);
}

/**
 * Sends an email verification email to the specified recipient.
 *
 * @param to - The recipient's email address  
 * @param token - The raw, unhashed verification token (not its hash)
 * @returns A promise that resolves when the email is sent
 */
export async function sendVerificationEmail(
  to: string,
  token: string,
): Promise<void> {
  await EmailService.sendVerificationEmail(to, token);
}
