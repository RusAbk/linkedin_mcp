import { lstat, readlink, unlink } from "node:fs/promises";
import path from "node:path";

const lockNames = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;
interface LockIO {
  readlink(file: string): Promise<string>;
  lstat(file: string): Promise<{ isSymbolicLink(): boolean }>;
  unlink(file: string): Promise<void>;
}
export async function recoverProfileLocks(profileDir: string, owner: { hostname: string; pidAlive(pid: number): boolean }, io: LockIO = { lstat, readlink, unlink }): Promise<string[]> {
  // The Docker entrypoint must hold the exclusive data-volume lock. Without it,
  // a foreign hostname can belong to a real browser in another container.
  const directory = path.resolve(profileDir);
  let target: string | undefined;
  try { target = await io.readlink(path.join(directory, "SingletonLock")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (target) {
    const match = /^(.*)-(\d+)$/.exec(target);
    if (!match || !match[1] || !match[2]) throw new Error("Неизвестный формат блокировки профиля Chrome; автоматическое восстановление отменено.");
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Некорректный PID в блокировке Chrome; автоматическое восстановление отменено.");
    if (match[1] === owner.hostname && owner.pidAlive(pid)) throw new Error("Профиль Chrome занят действующим процессом; блокировки сохранены.");
  }
  // Only transient symlinks are removed. Never follow their targets or touch cookies.
  const existing: string[] = [];
  for (const name of lockNames) {
    const file = path.join(directory, name);
    try {
      if (!(await io.lstat(file)).isSymbolicLink()) throw new Error(`${name} не является ссылкой; автоматическое восстановление отменено.`);
      existing.push(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const file of existing) await io.unlink(file);
  return existing.map(file => path.basename(file));
}
