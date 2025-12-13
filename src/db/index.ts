import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import { join } from 'path';
import * as schema from './schema';

// Get database path from environment or use default
const DB_PATH = process.env.DATABASE_PATH || './data/clawd.db';

// Resolve the path relative to the project root
const dbPath = DB_PATH.startsWith('/') ? DB_PATH : join(process.cwd(), DB_PATH);

// Initialize bun:sqlite connection
const sqlite = new Database(dbPath, { create: true });

// Enable WAL mode for better concurrent access
sqlite.exec('PRAGMA journal_mode = WAL');

// Enable foreign keys
sqlite.exec('PRAGMA foreign_keys = ON');

// Export drizzle db instance
export const db = drizzle(sqlite, { schema });

// Export the sqlite instance for raw queries if needed
export { sqlite };
