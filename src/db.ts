import { Db, MongoClient } from "mongodb";

const MONGO_URI =
  process.env.MONGO_URI ?? "mongodb://admin:admin123@localhost:27017/?authSource=admin";
const DB_NAME = process.env.DB_NAME ?? "location_service";

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
  }
  return db!;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
