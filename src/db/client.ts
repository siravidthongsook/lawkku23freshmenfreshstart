import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env";
import * as schema from "./schema/index";

// Single shared pool. Drizzle instance carries full schema for typed queries.
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export type DB = typeof db;
// Tx type — handlers needing row locks (capacity) accept this.
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
