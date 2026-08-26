import { rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = join(serverDir, 'data');

export default async function globalSetup() {
  for (const name of ['e2e-test.db', 'e2e-test.db-wal', 'e2e-test.db-shm']) {
    try { rmSync(join(dataDir, name), { force: true }); } catch { }
  }
  try {
    const uploads = join(dataDir, 'e2e-uploads');
    for (const entry of readdirSync(uploads)) rmSync(join(uploads, entry), { recursive: true, force: true });
  } catch { }
}
