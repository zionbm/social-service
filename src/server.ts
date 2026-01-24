import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { z } from "zod";
import { getDb, closeDb } from "./db.js";

type UserDoc = {
  _id?: unknown;
  email: string;
  publicId: string;
  dogName: string;
  dogPicture: string;
  friends: string[];
  blocked: string[];
  createdAt: Date;
};

type FriendRequestDoc = {
  _id?: unknown;
  fromId: string;
  toId: string;
  createdAt: Date;
};

const app = Fastify({ logger: true });

// --- Config ---
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";

// --- Plugins ---
await app.register(jwt, { secret: JWT_SECRET });

// --- Schemas ---
const IdParamSchema = z.object({
  id: z.string().min(1).max(200)
});

const RequestFriendSchema = z.object({
  toId: z.string().min(1).max(200)
});

const BlockSchema = z.object({
  blockId: z.string().min(1).max(200)
});

app.get("/health", async () => ({ ok: true }));

// Ensure indexes on start
app.addHook("onReady", async () => {
  const db = await getDb();
  await db.collection<UserDoc>("users").createIndex({ publicId: 1 }, { unique: true });
  await db.collection<FriendRequestDoc>("friend_requests").createIndex(
    { fromId: 1, toId: 1 },
    { unique: true }
  );
  await db.collection<FriendRequestDoc>("friend_requests").createIndex({ toId: 1 });
  await db.collection<FriendRequestDoc>("friend_requests").createIndex({ fromId: 1 });
});

// Require auth for all routes except /health
app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/health") return;
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ message: "Unauthorized" });
  }
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function getAuthedUser(req: any): Promise<UserDoc | null> {
  const email = req.user?.sub;
  if (!email || typeof email !== "string") return null;
  const db = await getDb();
  return db.collection<UserDoc>("users").findOne({ email: normalizeEmail(email) });
}

function safeList(list: string[] | undefined): string[] {
  return Array.isArray(list) ? list : [];
}

function isBlocked(me: UserDoc, other: UserDoc): boolean {
  return safeList(me.blocked).includes(other.publicId) || safeList(other.blocked).includes(me.publicId);
}

// -------- Routes --------

// Send friend request
app.post("/v1/friends/requests", async (req, reply) => {
  const parsed = RequestFriendSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
  }

  const me = await getAuthedUser(req);
  if (!me) return reply.code(401).send({ message: "Unauthorized" });

  const { toId } = parsed.data;
  if (toId === me.publicId) {
    return reply.code(400).send({ message: "Cannot friend yourself" });
  }

  const db = await getDb();
  const users = db.collection<UserDoc>("users");
  const requests = db.collection<FriendRequestDoc>("friend_requests");

  const target = await users.findOne({ publicId: toId });
  if (!target) return reply.code(404).send({ message: "User not found" });

  if (isBlocked(me, target)) {
    return reply.code(403).send({ message: "Blocked" });
  }

  if (safeList(me.friends).includes(target.publicId)) {
    return reply.code(409).send({ message: "Already friends" });
  }

  try {
    await requests.insertOne({ fromId: me.publicId, toId: target.publicId, createdAt: new Date() });
    return reply.code(201).send({ requested: true });
  } catch (err: any) {
    if (err?.code === 11000) {
      return reply.code(409).send({ message: "Request already exists" });
    }
    req.log.error(err);
    return reply.code(500).send({ message: "Internal error" });
  }
});

// Incoming friend requests
app.get("/v1/friends/requests/incoming", async (req, reply) => {
  const me = await getAuthedUser(req);
  if (!me) return reply.code(401).send({ message: "Unauthorized" });

  const db = await getDb();
  const requests = db.collection<FriendRequestDoc>("friend_requests");
  const items = await requests
    .find({ toId: me.publicId })
    .project({ _id: 0, fromId: 1, toId: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .toArray();

  return reply.code(200).send({ requests: items });
});

// Outgoing friend requests
app.get("/v1/friends/requests/outgoing", async (req, reply) => {
  const me = await getAuthedUser(req);
  if (!me) return reply.code(401).send({ message: "Unauthorized" });

  const db = await getDb();
  const requests = db.collection<FriendRequestDoc>("friend_requests");
  const items = await requests
    .find({ fromId: me.publicId })
    .project({ _id: 0, fromId: 1, toId: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .toArray();

  return reply.code(200).send({ requests: items });
});

// Approve friend request
app.post("/v1/friends/requests/:id/approve", async (req, reply) => {
  const parsed = IdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return reply.code(400).send({ message: "Invalid params", issues: parsed.error.issues });
  }

  const me = await getAuthedUser(req);
  if (!me) return reply.code(401).send({ message: "Unauthorized" });

  const fromId = parsed.data.id;
  if (fromId === me.publicId) {
    return reply.code(400).send({ message: "Invalid request" });
  }

  const db = await getDb();
  const users = db.collection<UserDoc>("users");
  const requests = db.collection<FriendRequestDoc>("friend_requests");

  const request = await requests.findOne({ fromId, toId: me.publicId });
  if (!request) return reply.code(404).send({ message: "Request not found" });

  const other = await users.findOne({ publicId: fromId });
  if (!other) return reply.code(404).send({ message: "User not found" });

  if (isBlocked(me, other)) {
    return reply.code(403).send({ message: "Blocked" });
  }

  await users.updateOne({ publicId: me.publicId }, { $addToSet: { friends: other.publicId } });
  await users.updateOne({ publicId: other.publicId }, { $addToSet: { friends: me.publicId } });

  await requests.deleteOne({ fromId, toId: me.publicId });
  await requests.deleteOne({ fromId: me.publicId, toId: fromId });

  return reply.code(200).send({ approved: true });
});

// Reject friend request
app.post("/v1/friends/requests/:id/reject", async (req, reply) => {
  const parsed = IdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return reply.code(400).send({ message: "Invalid params", issues: parsed.error.issues });
  }

  const me = await getAuthedUser(req);
  if (!me) return reply.code(401).send({ message: "Unauthorized" });

  const fromId = parsed.data.id;
  const db = await getDb();
  const requests = db.collection<FriendRequestDoc>("friend_requests");

  const result = await requests.deleteOne({ fromId, toId: me.publicId });
  if (result.deletedCount === 0) {
    return reply.code(404).send({ message: "Request not found" });
  }

  return reply.code(200).send({ rejected: true });
});

// Cancel sent request
app.delete("/v1/friends/requests/:id", async (req, reply) => {
  const parsed = IdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return reply.code(400).send({ message: "Invalid params", issues: parsed.error.issues });
  }

  const me = await getAuthedUser(req);
  if (!me) return reply.code(401).send({ message: "Unauthorized" });

  const toId = parsed.data.id;
  const db = await getDb();
  const requests = db.collection<FriendRequestDoc>("friend_requests");

  const result = await requests.deleteOne({ fromId: me.publicId, toId });
  if (result.deletedCount === 0) {
    return reply.code(404).send({ message: "Request not found" });
  }

  return reply.code(200).send({ cancelled: true });
});

// List friends
app.get("/v1/friends", async (req, reply) => {
  const me = await getAuthedUser(req);
  if (!me) return reply.code(401).send({ message: "Unauthorized" });
  return reply.code(200).send({ friends: safeList(me.friends) });
});

// Unfriend
app.delete("/v1/friends/:id", async (req, reply) => {
  const parsed = IdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return reply.code(400).send({ message: "Invalid params", issues: parsed.error.issues });
  }

  const me = await getAuthedUser(req);
  if (!me) return reply.code(401).send({ message: "Unauthorized" });

  const friendId = parsed.data.id;
  if (friendId === me.publicId) {
    return reply.code(400).send({ message: "Invalid request" });
  }

  const db = await getDb();
  const users = db.collection<UserDoc>("users");

  await users.updateOne({ publicId: me.publicId }, { $pull: { friends: friendId } });
  await users.updateOne({ publicId: friendId }, { $pull: { friends: me.publicId } });

  return reply.code(200).send({ unfriended: true });
});

// Block user
app.post("/v1/blocks", async (req, reply) => {
  const parsed = BlockSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
  }

  const me = await getAuthedUser(req);
  if (!me) return reply.code(401).send({ message: "Unauthorized" });

  const { blockId } = parsed.data;
  if (blockId === me.publicId) {
    return reply.code(400).send({ message: "Cannot block yourself" });
  }

  const db = await getDb();
  const users = db.collection<UserDoc>("users");
  const requests = db.collection<FriendRequestDoc>("friend_requests");

  const target = await users.findOne({ publicId: blockId });
  if (!target) return reply.code(404).send({ message: "User not found" });

  await users.updateOne({ publicId: me.publicId }, { $addToSet: { blocked: blockId } });

  await users.updateOne({ publicId: me.publicId }, { $pull: { friends: blockId } });
  await users.updateOne({ publicId: blockId }, { $pull: { friends: me.publicId } });

  await requests.deleteOne({ fromId: me.publicId, toId: blockId });
  await requests.deleteOne({ fromId: blockId, toId: me.publicId });

  return reply.code(200).send({ blocked: true });
});

// Unblock user
app.delete("/v1/blocks/:id", async (req, reply) => {
  const parsed = IdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return reply.code(400).send({ message: "Invalid params", issues: parsed.error.issues });
  }

  const me = await getAuthedUser(req);
  if (!me) return reply.code(401).send({ message: "Unauthorized" });

  const blockId = parsed.data.id;
  const db = await getDb();
  const users = db.collection<UserDoc>("users");

  await users.updateOne({ publicId: me.publicId }, { $pull: { blocked: blockId } });

  return reply.code(200).send({ unblocked: true });
});

// Shutdown
app.addHook("onClose", async () => {
  await closeDb();
});

const port = Number(process.env.PORT ?? 5000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });
