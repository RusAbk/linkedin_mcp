import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recoverProfileLocks } from '../dist/web/src/profile-locks.js';

const dataRoot = path.resolve(process.env.WEB_DATA_DIR ?? '/data');
const volumeLock = path.join(dataRoot, '.portal.lock');
// FD 9 is inherited from docker-start.sh and remains locked until the app exits.
if (process.platform !== 'linux' || await fs.readlink('/proc/self/fd/9').catch(() => '') !== volumeLock ||
  spawnSync('flock', ['--nonblock', volumeLock, 'true']).status !== 1) {
  throw new Error('Восстановление профилей требует эксклюзивной блокировки тома через docker-start.sh.');
}
const usersRoot = path.join(dataRoot, 'users');
const users = await fs.readdir(usersRoot, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
for (const user of users) {
  if (!user.isDirectory() || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(user.name)) continue;
  const profile = path.join(usersRoot, user.name, 'browser-profile');
  const stat = await fs.lstat(profile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
  const removed = await recoverProfileLocks(profile, { hostname: os.hostname(), pidAlive });
  if (removed.length) console.log(`Recovered stale Chrome profile locks for ${user.name}: ${removed.join(', ')}`);
}
