import Database from 'better-sqlite3';

const targets = [
  {
    name: 'legacy',
    file: '/app/data/chat.db',
    tables: ['users', 'servers', 'server_members', 'channels', 'messages', 'invites', 'bans'],
    userQuery: 'SELECT id, username, email, created_at FROM users ORDER BY created_at DESC LIMIT 20',
  },
  {
    name: 'core',
    file: '/app/data/discord-clone.db',
    tables: ['users', 'guilds', 'guild_members', 'channels', 'messages', 'invites', 'bans'],
    userQuery: 'SELECT id, username, email, created_at FROM users ORDER BY created_at DESC LIMIT 20',
  },
];

function printHeader(text) {
  console.log(`\n=== ${text} ===`);
}

for (const target of targets) {
  printHeader(`${target.name}: ${target.file}`);

  let db;
  try {
    db = new Database(target.file, { readonly: true, fileMustExist: true });
  } catch (error) {
    console.log(`open error: ${error.message}`);
    continue;
  }

  try {
    for (const table of target.tables) {
      try {
        const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0;
        console.log(`${table}: ${count}`);
      } catch (error) {
        console.log(`${table}: ERR ${error.message}`);
      }
    }

    try {
      const rows = db.prepare(target.userQuery).all();
      printHeader(`${target.name} users (last 20)`);
      console.table(rows);
    } catch (error) {
      console.log(`users query error: ${error.message}`);
    }
  } finally {
    db.close();
  }
}
