import { execa } from 'execa';

import type { ProcessProbe } from '../core/lock.js';

async function startedAt(pid: number, platform: NodeJS.Platform): Promise<number | null> {
  try {
    if (platform === 'win32') {
      const { stdout } = await execa('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
      ]);
      const parsed = Date.parse(stdout.trim());
      return Number.isNaN(parsed) ? null : parsed;
    }

    const { stdout } = await execa('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const parsed = Date.parse(stdout.trim());
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

export function createProcessProbe(platform: NodeJS.Platform): ProcessProbe {
  return {
    async exists(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    startedAt: (pid) => startedAt(pid, platform),
    self: process.pid,
  };
}
