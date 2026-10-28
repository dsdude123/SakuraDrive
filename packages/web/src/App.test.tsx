import { describe, expect, it } from 'vitest';
import { needsSignIn, type AuthStatus } from './App.js';

const status = (overrides: Partial<AuthStatus> = {}): AuthStatus => ({
  needsSetup: false,
  authRequired: true,
  authDisabled: false,
  user: null,
  version: 'test',
  siteName: 'SakuraDrive',
  ...overrides,
});

const signedIn = { id: 1, username: 'admin' };

describe('needsSignIn', () => {
  it('asks for a password when one is required and nobody is signed in', () => {
    expect(needsSignIn(status())).toBe(true);
  });

  it('lets a signed-in user through', () => {
    expect(needsSignIn(status({ user: signedIn }))).toBe(false);
  });

  it('shows the first-run screen when an account still has to be made', () => {
    expect(needsSignIn(status({ needsSetup: true }))).toBe(true);
  });

  /**
   * The trap this replaced: with authentication switched off the interface still sent
   * a fresh install to the setup screen and made someone invent a password that would
   * never be used again -- and on a rebuild, could not be got past at all.
   */
  it('does not demand an account when authentication is switched off', () => {
    expect(needsSignIn(status({ authRequired: false, authDisabled: true, needsSetup: true }))).toBe(
      false,
    );
  });

  it('lets anyone in when authentication is switched off and an account exists', () => {
    // The lost-password case: the account is still there, nobody can sign in to it,
    // and with the switch off nobody has to.
    expect(needsSignIn(status({ authRequired: false, authDisabled: true }))).toBe(false);
  });

  // `requireLogin` is the same decision taken in the settings rather than the
  // environment, and the server folds both into `authRequired`.
  it('honours the setting as well as the environment variable', () => {
    expect(needsSignIn(status({ authRequired: false, authDisabled: false }))).toBe(false);
  });
});
