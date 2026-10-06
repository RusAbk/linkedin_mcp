import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";

export interface User {
  id: string;
  username: string;
  role: "admin" | "user";
  disabled: number;
  action_mode: "review" | "execute";
  created_at: string;
}
type UserSecret = User & { password_salt: string; password_hash: string; token_hash: string | null };
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
function passwordFields(password: string) {
  if (password.length < 16 || password.length > 512) throw new Error("Пароль должен содержать от 16 до 512 символов.");
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: scryptSync(password, salt, 32).toString("hex") };
}
function visible(user: UserSecret): User {
  const { password_salt, password_hash, token_hash, ...safe } = user;
  return safe;
}
export class UserStore {
  private readonly db: DatabaseSync;
  private readonly dummySalt = randomBytes(16).toString("hex");
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('admin','user')),
      disabled INTEGER NOT NULL DEFAULT 0, action_mode TEXT NOT NULL DEFAULT 'review' CHECK(action_mode IN ('review','execute')),
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, token_hash TEXT UNIQUE, created_at TEXT NOT NULL
    );`);
  }
  list(): User[] { return (this.db.prepare("SELECT * FROM users ORDER BY created_at").all() as unknown as UserSecret[]).map(visible); }
  get(id: string): User | undefined { const user = this.db.prepare("SELECT * FROM users WHERE id=?").get(id) as UserSecret | undefined; return user ? visible(user) : undefined; }
  create(username: string, password: string, role: User["role"] = "user"): User {
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) throw new Error("Логин: 3–64 латинских символа, цифры, _, . или -.");
    const { salt, hash } = passwordFields(password);
    const id = randomUUID();
    this.db.prepare("INSERT INTO users(id,username,role,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)").run(id, username, role, salt, hash, new Date().toISOString());
    return this.get(id)!;
  }
  authenticate(username: string, password: string): User | undefined {
    const user = this.db.prepare("SELECT * FROM users WHERE username=?").get(username) as UserSecret | undefined;
    const hash = scryptSync(password, user?.password_salt ?? this.dummySalt, 32);
    if (!user || user.disabled || !timingSafeEqual(hash, Buffer.from(user.password_hash, "hex"))) return undefined;
    return visible(user);
  }
  tokenUser(token: string): User | undefined {
    if (!/^ln_[a-f0-9]{64}$/.test(token)) return undefined;
    const user = this.db.prepare("SELECT * FROM users WHERE token_hash=? AND disabled=0").get(tokenHash(token)) as UserSecret | undefined;
    return user ? visible(user) : undefined;
  }
  rotateToken(id: string): string {
    const token = `ln_${randomBytes(32).toString("hex")}`;
    this.db.prepare("UPDATE users SET token_hash=? WHERE id=?").run(tokenHash(token), id);
    return token;
  }
  revokeToken(id: string) { this.db.prepare("UPDATE users SET token_hash=NULL WHERE id=?").run(id); }
  update(id: string, values: { disabled?: boolean; actionMode?: User["action_mode"]; password?: string }) {
    if (values.password !== undefined) {
      const { salt, hash } = passwordFields(values.password);
      this.db.prepare("UPDATE users SET password_salt=?,password_hash=?,token_hash=NULL WHERE id=?").run(salt, hash, id);
    }
    if (values.disabled !== undefined) this.db.prepare("UPDATE users SET disabled=?,token_hash=NULL WHERE id=?").run(Number(values.disabled), id);
    if (values.actionMode !== undefined) this.db.prepare("UPDATE users SET action_mode=? WHERE id=?").run(values.actionMode, id);
  }
  close() { this.db.close(); }
}
