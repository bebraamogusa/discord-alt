import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'fs';
import { dirname, extname, join } from 'path';

export function createDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function runMigrations(db, migrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);

  const files = readdirSync(migrationsDir)
    .filter((name) => extname(name).toLowerCase() === '.sql')
    .sort((a, b) => a.localeCompare(b));

  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map((row) => row.filename)
  );

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)' 
  );

  const apply = db.transaction((filename, sql) => {
    db.exec(sql);
    insertMigration.run(filename, Math.floor(Date.now() / 1000));
  });

  for (const filename of files) {
    if (applied.has(filename)) continue;
    const fullPath = join(migrationsDir, filename);
    const sql = readFileSync(fullPath, 'utf8');
    apply(filename, sql);
  }
}
