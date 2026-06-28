import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { SessionStore, User } from "./store.js";

/**
 * Lightweight username/password auth with a per-user API token.
 *
 *  - The web UI logs in with username + password to see its personal scoreboard.
 *  - The matcher client identifies itself with the user's API token (so every
 *    session is provably tied to a real user — no anonymous play).
 *
 * Passwords are hashed with scrypt (built-in `crypto`, no external deps) and
 * stored as `scrypt$<saltHex>$<hashHex>`.
 */

const SCRYPT_KEYLEN = 64;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function newId(): string {
  return randomBytes(9).toString("base64url"); // 12-char id
}

function newToken(): string {
  return randomBytes(24).toString("base64url"); // 32-char API token
}

/** What's returned to the caller after a successful register/login. */
export interface AuthResult {
  id: string;
  username: string;
  token: string;
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class AuthService {
  constructor(private store: SessionStore) {}

  private static normalize(username: string): { username: string; usernameLc: string } {
    const trimmed = username.trim();
    return { username: trimmed, usernameLc: trimmed.toLowerCase() };
  }

  async register(usernameRaw: string, password: string): Promise<AuthResult> {
    const { username, usernameLc } = AuthService.normalize(usernameRaw);
    if (!/^[a-zA-Z0-9_.\- ]{3,30}$/.test(username)) {
      throw new AuthError(400, "username must be 3–30 chars (letters, digits, _ . - space)");
    }
    if (typeof password !== "string" || password.length < 6) {
      throw new AuthError(400, "password must be at least 6 characters");
    }
    if (await this.store.getUserByUsername(usernameLc)) {
      throw new AuthError(409, "username already taken");
    }
    const user: User = {
      id: newId(),
      username,
      usernameLc,
      password: hashPassword(password),
      token: newToken(),
    };
    await this.store.createUser(user);
    return { id: user.id, username: user.username, token: user.token };
  }

  async login(usernameRaw: string, password: string): Promise<AuthResult> {
    const { usernameLc } = AuthService.normalize(usernameRaw);
    const user = await this.store.getUserByUsername(usernameLc);
    if (!user || !verifyPassword(password, user.password)) {
      throw new AuthError(401, "wrong username or password");
    }
    return { id: user.id, username: user.username, token: user.token };
  }

  /** Resolve an API token to its user (for gating session creation/driving). */
  async userFromToken(token: string | undefined | null): Promise<User | undefined> {
    if (!token) return undefined;
    return this.store.getUserByToken(token);
  }
}
