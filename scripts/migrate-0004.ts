import { Database } from 'bun:sqlite';

const db = new Database('/data/clawd.db');

try {
  db.exec('ALTER TABLE users ADD COLUMN archetype TEXT');
  console.log('Added archetype column');
} catch (e: any) {
  if (e.message.includes('duplicate column')) {
    console.log('archetype column already exists');
  } else {
    throw e;
  }
}

try {
  db.exec('ALTER TABLE users ADD COLUMN archetype_secondary TEXT');
  console.log('Added archetype_secondary column');
} catch (e: any) {
  if (e.message.includes('duplicate column')) {
    console.log('archetype_secondary column already exists');
  } else {
    throw e;
  }
}

try {
  db.exec('ALTER TABLE users ADD COLUMN archetype_updated_at INTEGER');
  console.log('Added archetype_updated_at column');
} catch (e: any) {
  if (e.message.includes('duplicate column')) {
    console.log('archetype_updated_at column already exists');
  } else {
    throw e;
  }
}

console.log('Migration complete');
