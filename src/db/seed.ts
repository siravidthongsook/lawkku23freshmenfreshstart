import { eq, inArray } from "drizzle-orm";
import { db, pool } from "./client";
import { temporaryPasswords, users } from "./schema/users";
import { events } from "./schema/events";
import { hashPassword, generateTempPassword, validatePasswordPolicy } from "../lib/password";
import { encryptSecret } from "../lib/crypto";

// Idempotent first-admin seed. Skips if ANY admin already exists. Prints email + starting password.
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@lawkku-freshstart23.local";
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? "System Admin";
// Starting password: predictable via env (default below), else random. Admin must change it on first login.
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

// Bangkok-local datetime → UTC Date (store UTC; +07:00 offset literal in the string).
const bkk = (isoNoTz: string) => new Date(`${isoNoTz}+07:00`);

// LAW23 / KKU63 freshman-activity calendar (B.E. 2569 = 2026). Poster files live in web/public/gallery.
// Seeded published+listed so they show on the public list; registrationMode closed (no forms yet).
const SEED_EVENTS = [
  { slug: "phuk-siao-huam-jai", img: "event-5", date: "2026-06-15", title: "โครงการผูกเสี่ยวฮวมใจ สานสายใยมอดินแดง", org: "องค์การนักศึกษา มข." },
  { slug: "hak-paeng-paeng-pan", img: "event-8", date: "2026-06-17", title: "โครงการฮักแพงแปงปั้น สานสายใยสร้างสรรค์ กลุ่มสัมพันธ์น้องใหม่มอดินแดง", org: "องค์การนักศึกษา มข." },
  { slug: "orientation-kku63", img: "event-14", date: "2026-06-18", title: "ปฐมนิเทศนักศึกษาใหม่ กาลพฤกษ์ช่อที่ 63", org: "องค์การนักศึกษา มข." },
  { slug: "orientation-law", img: "event-11", date: "2026-06-19", title: "ปฐมนิเทศนักศึกษาใหม่ คณะนิติศาสตร์", org: "คณะนิติศาสตร์" },
  { slug: "tum-home-sattha", img: "event-7", date: "2026-06-20", title: "กิจกรรมตุ้มโฮมศรัทธาสิริสักกา ปูชะยาเจ้าพ่อมอดินแดง", org: "องค์การนักศึกษา มข." },
  { slug: "home-hap-kalapruek", img: "event-4", date: "2026-06-21", title: "กิจกรรมโฮมฮับกาลพฤกษ์ช่อใหม่ ร่วมใจฮักมั่น สานสัมพันธ์มอดินแดง (ประดับช่อ)", org: "องค์การนักศึกษา มข." },
  { slug: "phuk-hak-huam-jai", img: "event-1", date: "2026-06-23", title: "กิจกรรมผูกฮัก ฮวมใจ สานสายใยลูกรพีมอดินแดง", org: "สโมสรนักศึกษาคณะนิติศาสตร์" },
  { slug: "roi-sai-yai-hak", img: "event-13", date: "2026-06-25", title: "ฮ้อยสายใยฮัก ถักทอสายสัมพันธ์ ฮ่วมผูกพันสักทอง", org: "สโมสรนักศึกษาคณะนิติศาสตร์" },
  { slug: "first-step-legal", img: "event-10", date: "2026-06-27", title: "First Step : Shaping Future Legal Professionals — ก้าวแรกสู่นักกฎหมายแห่งอนาคต", org: "คณะนิติศาสตร์" },
  { slug: "open-world-activities", img: "event-6", date: "2026-06-28", title: "กิจกรรมเปิดโลกทัศน์กิจกรรมนักศึกษา มหาวิทยาลัยขอนแก่น", org: "องค์การนักศึกษา มข." },
  { slug: "law-freshy-night-2026", img: "event-16", date: "2026-07-03", title: "เปิดโลกทัศน์กิจกรรม : LAW KKU Freshy Night 2026 / บุญออนซอน : ม่วนซื่นคืนโขง", org: "สโมสรนักศึกษาคณะนิติศาสตร์" },
] as const;

// Ensure an admin exists; return its id (existing or freshly bootstrapped).
async function ensureAdmin(): Promise<string> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (existing) {
    console.log("[seed] An admin already exists — skipping admin bootstrap (idempotent).");
    return existing.id;
  }

  // Use the configured starting password if it passes policy; else fall back to a random temp.
  const policyErr = validatePasswordPolicy(ADMIN_PASSWORD);
  const tempPw = policyErr ? generateTempPassword() : ADMIN_PASSWORD;
  if (policyErr) {
    console.warn(`[seed] SEED_ADMIN_PASSWORD rejected (${policyErr}) — using a random one instead.`);
  }
  const passwordHash = await hashPassword(tempPw);

  const admin = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({
        email: ADMIN_EMAIL,
        role: "admin",
        fullName: ADMIN_NAME,
        passwordHash,
        passwordMustChange: true, // force change on first login
        createdByAdminId: null, // bootstrap admin has no creator
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("[seed] insert returned no row");
    // Keep encrypted temp so it can be re-exported until first password change.
    await tx.insert(temporaryPasswords).values({
      userId: row.id,
      encryptedTempPassword: encryptSecret(tempPw),
      createdByAdminId: row.id, // self-created bootstrap admin
    });
    return row;
  });

  console.log("[seed] Created first admin:");
  console.log(`        email:             ${admin.email}`);
  console.log(`        starting password: ${tempPw}`);
  console.log("[seed] Must change password on first login.");
  return admin.id;
}

// Seed LAW23 events. Idempotent by slug — only inserts events not already present.
async function seedEvents(adminId: string): Promise<void> {
  const slugs = SEED_EVENTS.map((e) => e.slug);
  const present = await db
    .select({ slug: events.publicSlug })
    .from(events)
    .where(inArray(events.publicSlug, slugs));
  const have = new Set(present.map((r) => r.slug));

  const toInsert = SEED_EVENTS.filter((e) => !have.has(e.slug)).map((e) => ({
    title: e.title,
    description: `จัดโดย ${e.org}`,
    location: "มหาวิทยาลัยขอนแก่น",
    posterImageUrl: `/gallery/${e.img}.jpg`, // static web asset (web/public/gallery)
    publicSlug: e.slug,
    status: "published" as const, // visible on public list
    visibility: "listed" as const,
    registrationMode: "closed" as const, // no forms seeded
    eventStartAt: bkk(`${e.date}T09:00:00`),
    eventEndAt: bkk(`${e.date}T17:00:00`),
    createdByAdminId: adminId,
  }));

  if (toInsert.length === 0) {
    console.log("[seed] All LAW23 events already present — skipping (idempotent).");
    return;
  }
  await db.insert(events).values(toInsert);
  console.log(`[seed] Inserted ${toInsert.length} event(s); skipped ${have.size} existing.`);
}

async function seed(): Promise<void> {
  const adminId = await ensureAdmin();
  await seedEvents(adminId);
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[seed] failed:", err);
    return pool.end().finally(() => process.exit(1));
  });
