# LawKKUFreshmenFreshStart23 & Event Registration System Spec — V1

## 1. Product Summary

ระบบเว็บ LawKKUFreshmenFreshStart23 สำหรับกิจกรรมนักศึกษาใหม่ ภายใน site เดียวขององค์กร/ชมรม/มหาวิทยาลัย ไม่ใช่ multi-tenant SaaS

Core flow:

1. Admin สร้าง event
2. Admin config registration mode, time window, form, capacity, check-in window
3. Student เข้าหน้า public event จาก event list หรือ QR
4. Student login ด้วย email/password
5. Student กรอก registration form
6. Submit สำเร็จแล้วได้ event registration ใน account
7. Student เปิด QR ticket ตอนเข้างาน
8. Check-in Staff scan QR หรือ search ชื่อ/รหัสนักศึกษาเพื่อ manual check-in
9. ระบบเปลี่ยนสถานะเป็น checked-in
10. Admin export รายชื่อ/attendance/form answers เป็น CSV/XLSX

---

# 2. Roles & Permissions

## 2.1 Roles

ระบบมี 3 roles ใน V1:

```ts
role:
  student
  checkin_staff
  admin
```

## 2.2 Student

Student ทำได้:

* login ด้วย email/password
* ดู public event list
* ดู public event page
* register event
* join waitlist ถ้า event เต็มและเปิด waitlist
* cancel registration เองได้ เฉพาะ event ที่ admin เปิดให้
* edit form answers เองได้ เฉพาะ event ที่ admin เปิดให้ และยังไม่เลย deadline
* ดู event ที่ตัวเอง registered/waitlisted/checked-in/cancelled
* เปิด QR ticket ของ registration ตัวเอง
* download uploaded files ของตัวเอง

Student ทำไม่ได้:

* check-in ตัวเอง
* regenerate QR เอง
* เห็น registration ของคนอื่น
* เห็น audit log
* export data

---

## 2.3 Check-in Staff

Check-in Staff เป็น global staff ใน V1

Staff ทุกคน:

* เห็นทุก event ที่ check-in ได้
* scan QR ของทุก event
* manual search เฉพาะ registration ใน event ที่กำลัง check-in
* manual check-in ได้
* undo check-in ได้
* ต้องใส่ reason ตอน undo/manual sensitive action

Staff เห็นข้อมูลขั้นต่ำเท่านั้น:

```ts
student_id
full_name
registration_status
checked_in_at
checked_in_by
faculty?
department?
```

Staff ไม่เห็น:

```ts
email
phone
form answers
uploaded files
temp password
audit log ทั้งหมด
```

---

## 2.4 Admin

V1 มี Admin ระดับเดียว

Admin ทำได้ทั้งหมด:

* create/edit/manage events
* move event status ไปมา
* configure event registration mode
* configure registration/check-in windows
* configure form fields
* import users via CSV/XLSX
* create/edit/disable/enable users
* reset password
* export temp passwords for users who still must change password
* change user role
* view registrations
* view form answers
* view/download uploaded files
* manual register/cancel/promote/demote/override registration
* override registration แม้ registration ปิดอยู่
* override capacity
* regenerate/revoke QR
* export CSV/XLSX
* view audit logs

V1 ไม่มี hard delete user/event/registration/file ผ่าน UI

---

# 3. User Identity & Account Model

## 3.1 User Primary Key

ใช้ UUID เป็น primary key เดียว

```ts
users {
  id uuid primary key
  email text unique not null
  student_id text unique null
  role enum('student', 'checkin_staff', 'admin') not null
  full_name text not null
  faculty text null
  department text null
  phone text null
  password_hash text not null
  password_must_change boolean not null default false
  status enum('active', 'disabled') not null default 'active'
  created_by_admin_id uuid null
  created_at timestamptz not null
  updated_at timestamptz not null
}
```

Rules:

* `users.id` คือ internal identity
* `student_id` เป็น business identifier ของ student
* `student_id` unique ทั้งระบบ
* `email` unique ทั้งระบบ
* Table อื่น reference user ด้วย `user_id` เท่านั้น
* Admin แก้ `email` / `student_id` ได้ แต่ต้อง unique และ audit log
* Registration ไม่พังเมื่อแก้ email/student_id เพราะผูกกับ `user_id`

---

# 4. Authentication & Session

## 4.1 Login Method

ทุก role ใช้:

```txt
email + password
```

ไม่มี magic link / OTP ใน V1

## 4.2 Password Policy

User-created password:

```txt
minimum length: 10
maximum length: 128
block common passwords
allow printable characters
do not require uppercase/lowercase/number/symbol combo
```

Password hash:

```txt
Preferred: Argon2id
Fallback: bcrypt cost 12+
```

Temporary password:

```txt
14–16 random chars
readable format เช่น J7xq-29Lm-Vp4z
must change on first login
```

## 4.3 Temporary Password Flow

V1 ไม่มี email service

Admin create/import user แล้วระบบ generate temp password

```ts
users.password_must_change = true
```

Temp password export ได้หลายครั้ง แต่เฉพาะ account ที่ยังไม่เปลี่ยน password

เพื่อ export ซ้ำได้ ต้องเก็บ temp password แบบ encrypted แยกจาก password hash

```ts
temporary_passwords {
  user_id uuid primary key references users(id)
  encrypted_temp_password text not null
  created_by_admin_id uuid not null
  created_at timestamptz not null
  expires_at timestamptz null
}
```

Rules:

* `users.password_hash` ใช้ login
* `temporary_passwords.encrypted_temp_password` ใช้ export ให้ admin
* เมื่อ user เปลี่ยน password:

  * update `password_hash`
  * set `password_must_change = false`
  * delete temporary password row
* Admin reset password ได้:

  * generate temp password ใหม่
  * update password hash
  * upsert encrypted temp password
  * set `password_must_change = true`
  * revoke all sessions ของ user
  * audit log

## 4.4 Forgot Password

V1 ไม่มี self-service forgot password

Flow:

1. User กด forgot password
2. แสดงข้อความให้ติดต่อ admin
3. Admin reset password
4. User login ด้วย temp password
5. User must change password immediately

Future:

```txt
email service + reset password link/token
```

## 4.5 Sessions

ใช้ server-side session cookie

Cookie:

```txt
HttpOnly
Secure
SameSite=Lax
```

Session TTL by role:

```txt
Student: 30 days
Check-in Staff: 12 hours
Admin: 8 hours
```

No remember me ใน V1

Rules:

* login ทุกครั้งออก session ตาม role ปัจจุบัน
* เปลี่ยน password → revoke sessions อื่น
* admin reset password → revoke sessions ทั้งหมดของ user
* disabled user → session ใช้ต่อไม่ได้
* change role แล้ว session ใหม่ต้องใช้ TTL ตาม role ใหม่

## 4.6 Login Rate Limit & Lockout

ต้องมีตั้งแต่ V1

ป้องกัน 3 มิติ (layered) — กันให้แม่นขึ้นโดยไม่ block นักศึกษาบริสุทธิ์ที่อยู่หลัง campus NAT IP เดียวกัน:

```txt
1. account (email/identifier) — HARD lock
   5 failed attempts / 10 minutes / account → lockout 15 นาที
   แม่นที่สุด, ลบ/เปลี่ยน device ก็หนีไม่พ้น, admin unlock ได้

2. device — SOFT block
   FE สร้าง random deviceId (localStorage) ส่งมาเป็น header X-Device-Id
   10 failed attempts / 10 minutes / device → block (ไม่มี lockout row, หายเองเมื่อ fail พ้น window)
   เป็นสัญญาณ precision เท่านั้น (ลบ/ปลอมได้) — ไม่ใช่ security boundary
   ถ้า client ไม่ส่ง header → ข้ามมิตินี้ (account + IP ยังคุ้ม)

3. IP — SMART backstop (credential-stuffing signature)
   block IP เฉพาะเมื่อเข้าครบทั้ง 3 เงื่อนไขใน window:
     fails >= 30  AND  distinct accounts >= 8  AND  successes == 0
   มี success แม้ครั้งเดียวใน window = ไม่ block (campus wifi มี success ปนเสมอ จึงไม่โดนลูกหลง)
   ยิงเดี่ยวจาก attack box (ไม่เคย login ถูก) ถึงจะติด

WINDOW = 10 นาที, Temporary lockout (account) = 15 นาที
เลข threshold ทั้งหมดเป็น tunable constant บนหัวไฟล์ src/modules/auth/service.ts
```

Error message:

```txt
Invalid email or password
```

ห้ามบอกว่า email มีอยู่จริงไหม

Admin unlock account ได้

Audit log:

```txt
login_failed_rate_limited
account_temporarily_locked
admin_unlocked_account
```

---

# 5. Event Model

## 5.1 Event Status

```ts
event_status:
  draft
  published
  cancelled
  archived
```

Admin move event status ไปมาได้ ไม่ permanent

Status change เป็น non-destructive operation:

* ไม่ลบ registration
* ไม่ลบ form answers
* ไม่ลบ uploaded files
* ไม่ลบ check-in records
* ไม่ลบ audit logs

ทุก status change ต้อง audit log

## 5.2 Event Visibility

```ts
visibility:
  listed
  unlisted
```

Meaning:

* `listed` = ขึ้น public event list
* `unlisted` = ไม่ขึ้น public event list แต่ direct link ยังเปิดได้

Rules:

* `draft` ไม่ public เสมอ
* `published + listed` ขึ้น public list
* `published + unlisted` ไม่ขึ้น list แต่ direct link ได้
* `cancelled + listed` ขึ้น public list พร้อม badge Cancelled
* `cancelled + unlisted` ไม่ขึ้น list แต่ direct link ยังเห็น cancelled page
* `archived` ไม่ขึ้น list แต่ direct link read-only ได้

## 5.3 Event Fields

```ts
events {
  id uuid primary key
  public_id uuid unique not null
  public_slug text unique not null

  title text not null
  description text null
  location text null

  status enum('draft', 'published', 'cancelled', 'archived') not null
  visibility enum('listed', 'unlisted') not null default 'listed'

  registration_mode enum('public_self_register', 'admin_import_only', 'closed') not null
  registration_open_at timestamptz null
  registration_close_at timestamptz null

  checkin_open_at timestamptz null
  checkin_close_at timestamptz null

  event_start_at timestamptz null
  event_end_at timestamptz null

  capacity_enabled boolean not null default false
  capacity_limit int null
  waitlist_enabled boolean not null default false

  allow_student_cancel_registration boolean not null default false
  cancel_registration_close_at timestamptz null

  allow_student_edit_registration boolean not null default false
  edit_registration_close_at timestamptz null

  created_by_admin_id uuid not null
  created_at timestamptz not null
  updated_at timestamptz not null
}
```

## 5.4 Public Event URLs

มี 2 routes:

```txt
/events/:public_slug
/e/:public_id
```

* `/events/:public_slug` = pretty URL แก้ slug ได้
* `/e/:public_id` = permanent QR URL ไม่เปลี่ยน

`public_slug` แก้ได้ แต่ไม่เก็บ slug history ใน V1

`public_id` แยกจาก internal `events.id`

QR ของ public event page ใช้:

```txt
/e/:public_id
```

เมื่อเปิด `/e/:public_id`:

* resolve event ด้วย public_id
* redirect ไป current slug URL `/events/:public_slug`
* ถ้าไม่มี slug fallback render ผ่าน `/e/:public_id`

---

# 6. Registration Mode & Time Windows

## 6.1 Registration Mode

ตั้งค่าแยก per event

```ts
registration_mode:
  public_self_register
  admin_import_only
  closed
```

Behavior:

### public_self_register

* Student สมัคร/login เองได้
* กด register ได้ถ้าอยู่ใน registration window
* capacity rule apply

### admin_import_only

* Student ต้องมี account อยู่แล้ว
* Public self-register ไม่ได้
* Admin import/register ให้ได้

### closed

* Student register ไม่ได้
* Admin override register ได้ พร้อม audit log

## 6.2 Time Windows

Event มี time windows แยกจาก status:

```txt
registration_open_at
registration_close_at

checkin_open_at
checkin_close_at

event_start_at
event_end_at
```

Registration closed ไม่ใช่ event status แต่คำนวณจากเวลา

Admin override ได้ แม้ registration/check-in ปิดอยู่ แต่ต้อง audit log

## 6.3 Timezone

DB เก็บเวลาเป็น UTC

UI/export แสดงเป็น Asia/Bangkok

Rules:

* Admin ตั้งเวลาใน UI เป็นเวลาไทย
* Backend แปลงเป็น UTC ก่อนเก็บ
* Export timestamp เป็นเวลาไทย พร้อม label เช่น `checked_in_at_bangkok`
* Audit log เก็บ UTC แต่ UI render เป็นเวลาไทย

---

# 7. Registration Model

## 7.1 Registration Table

```ts
registrations {
  id uuid primary key
  event_id uuid not null references events(id)
  user_id uuid not null references users(id)

  status enum('registered', 'waitlisted', 'checked_in', 'cancelled') not null

  form_version_id uuid null

  registered_at timestamptz null
  waitlisted_at timestamptz null
  checked_in_at timestamptz null
  cancelled_at timestamptz null

  checked_in_by_user_id uuid null references users(id)
  checkin_method enum('qr_scan', 'manual_search') null
  manual_checkin_reason text null

  created_at timestamptz not null
  updated_at timestamptz not null

  unique(event_id, user_id)
}
```

Rules:

* 1 user ต่อ 1 event มี registration record เดียว
* ลงทะเบียนซ้ำ redirect ไป already registered/waitlisted page
* V1 ไม่มี hard delete registration
* ใช้ status lifecycle แทน

## 7.2 Registration Status

```ts
registration_status:
  registered
  waitlisted
  checked_in
  cancelled
```

## 7.3 Student Transitions

Student ทำเองได้:

```txt
none -> registered
none -> waitlisted
registered -> cancelled
waitlisted -> cancelled
cancelled -> registered
cancelled -> waitlisted
```

Conditions:

* `registered -> cancelled` ได้เฉพาะ event เปิด allow student cancel และยังไม่เลย deadline
* `cancelled -> registered` ได้ถ้า registration ยังเปิดและ capacity ยังไม่เต็ม
* `cancelled -> waitlisted` ได้ถ้า registration ยังเปิด เต็มแล้ว และ waitlist เปิด

## 7.4 Staff Transitions

Staff ทำได้เฉพาะ check-in context:

```txt
registered -> checked_in
checked_in -> registered
```

Undo check-in ต้องมี reason

Staff ทำไม่ได้:

* cancel registration
* promote/demote waitlist
* edit form answers
* register student ใหม่
* export

## 7.5 Admin Transitions

Admin ทำได้แบบ controlled override:

```txt
none -> registered
none -> waitlisted
waitlisted -> registered
registered -> waitlisted
registered -> cancelled
waitlisted -> cancelled
checked_in -> registered
checked_in -> cancelled
cancelled -> registered
cancelled -> waitlisted
```

Sensitive action ต้องมี reason + audit log

Examples:

* register after registration closed
* register over capacity
* cancel registration
* promote/demote waitlist
* undo checked-in
* checked_in -> cancelled

---

# 8. Capacity & Waitlist

## 8.1 Capacity

Event config:

```ts
capacity_enabled boolean
capacity_limit int null
```

ถ้า `capacity_enabled = false`:

* ลงทะเบียนได้ไม่จำกัดใน registration window

ถ้า `capacity_enabled = true`:

* public registration ต้องเช็ค capacity

นับเฉพาะ:

```txt
registered
checked_in
```

ไม่นับ:

```txt
cancelled
waitlisted
```

## 8.2 Waitlist

Event config:

```ts
waitlist_enabled boolean
```

ถ้า capacity full:

```txt
waitlist_enabled = true  -> show Join Waitlist
waitlist_enabled = false -> show Registration Full
```

Waitlist เป็น status ใน `registrations` table เดิม

V1 ไม่มี auto-promote

Admin promote/demote เองได้ พร้อม audit log

## 8.3 Race Condition Protection

Public registration submit ต้องใช้ database transaction + lock/atomic check

Pseudo logic:

```ts
BEGIN;

lock event row;

current_count = count(registrations where event_id = ? and status in ('registered', 'checked_in'));

if capacity disabled:
  create registration registered
else if current_count < capacity_limit:
  create registration registered
else if waitlist_enabled:
  create registration waitlisted
else:
  reject registration_full

COMMIT;
```

Admin override/import ไม่ใช้ public capacity rule ปกติ แต่ต้อง warning + audit log ถ้าทำให้เกิน capacity

---

# 9. Registration Form System

## 9.1 Form Style

ใช้ Google Forms-style simple fields

V1 field types:

```ts
field_type:
  short_text
  paragraph
  number
  single_choice
  multiple_choice
  dropdown
  checkbox
  date
  time
  file_upload
```

## 9.2 Form Versioning

ใช้ form versioning ตั้งแต่ V1

```ts
event_form_versions {
  id uuid primary key
  event_id uuid not null references events(id)
  version_number int not null
  schema_json jsonb not null
  created_by_admin_id uuid not null
  created_at timestamptz not null
  is_active boolean not null
}
```

Registration ผูกกับ:

```ts
registrations.form_version_id
```

Rules:

* ถ้า event ยังไม่มี registration → admin แก้ form ได้ปกติ
* ถ้ามีคน submit แล้ว → schema change สำคัญสร้าง form version ใหม่
* registration เก่ายังอิง version เดิม
* registration ใหม่ใช้งาน active version ล่าสุด
* label typo/help text/sort order อาจแก้ได้ แต่ควร audit log
* export ต้อง include `form_version`

## 9.3 Form Answers

```ts
registration_form_answers {
  id uuid primary key
  registration_id uuid not null references registrations(id)
  form_version_id uuid not null references event_form_versions(id)
  field_key text not null
  value jsonb null
  created_at timestamptz not null
  updated_at timestamptz not null

  unique(registration_id, field_key)
}
```

## 9.4 No Draft Submission in V1

V1 ไม่มี draft/save-later

Flow:

```txt
Student กด Register
-> กรอก form
-> Submit
-> Backend validate
-> Create registration
-> Done
```

ยังไม่นับว่า registered จนกว่า submit สำเร็จ

Capacity check ต้องทำตอน submit จริง

## 9.5 Student Edit Answers

Event config:

```ts
allow_student_edit_registration boolean
edit_registration_close_at timestamptz null
```

Rules:

* Student edit answers ได้เฉพาะ event ที่เปิดให้
* ต้องยังไม่เลย edit deadline
* ถ้า status เป็น `checked_in` แล้ว student แก้เองไม่ได้
* ถ้า form version เปลี่ยนหลัง submit แล้ว student edit ควรใช้ schema version เดิมของ registration ไม่ auto migrate
* Admin override edit ได้เสมอ พร้อม reason + audit log

## 9.6 Admin Edit Answers

Admin แก้ form answers ได้

Rules:

* ต้องใส่ reason
* audit log ทุกครั้ง
* ถ้า field เป็น file upload:

  * upload file ใหม่
  * file เก่า soft delete
  * deleted_reason = `replaced_by_admin`
* Student เห็นข้อมูลล่าสุด
* Staff ไม่เห็น form answers

---

# 10. File Upload

## 10.1 V1 File Upload Config

Default:

```txt
Allowed: PDF, JPG/JPEG, PNG
max_files: 1
max_file_size: 5MB
```

ใช้ allow-list เป็นหลัก

Block executable/script/archive/macro เช่น:

```txt
.exe
.js
.html
.svg
.zip
.rar
.docm
.xlsm
```

Validate:

* file extension
* MIME type
* file size

## 10.2 Storage

V1 ใช้ local private storage แต่เขียนผ่าน `StorageProvider`

```ts
StorageProvider {
  upload()
  getPrivateDownloadUrl()
  delete()
}
```

Implementations:

```txt
local_private_storage // V1
s3_compatible_storage // future: S3/R2/MinIO
```

ห้ามเก็บใน public `/uploads`

Download ต้องผ่าน backend authorization

## 10.3 Uploaded File Table

```ts
uploaded_files {
  id uuid primary key

  owner_user_id uuid not null references users(id)
  event_id uuid not null references events(id)
  registration_id uuid not null references registrations(id)
  form_version_id uuid not null references event_form_versions(id)
  form_field_key text not null

  original_filename text not null
  stored_object_key text not null
  mime_type text not null
  file_size_bytes int not null
  checksum_sha256 text not null

  uploaded_at timestamptz not null
  deleted_at timestamptz null
  deleted_reason text null
}
```

## 10.4 File Lifecycle

ใช้ soft delete + keep history

Rules:

* user replace file → old file `deleted_at = now()`, reason = `replaced_by_user`
* admin replace file → old file soft delete, reason = `replaced_by_admin`
* cancel registration ไม่ลบไฟล์
* deactivate/remove form field ไม่ลบไฟล์เก่า
* V1 ไม่มี hard delete ผ่าน UI

## 10.5 File Permissions

Student:

* download เฉพาะไฟล์ตัวเอง

Admin:

* download ทุกไฟล์

Staff:

* ไม่เห็นไฟล์

Download endpoint:

```http
GET /files/:fileId/download
```

Backend ต้อง authorize ก่อน stream/signed URL

Audit log:

* admin download file ต้อง log
* student download ไฟล์ตัวเองไม่จำเป็นต้อง log ละเอียดใน V1

---

# 11. QR Ticket & Check-in

## 11.1 Registration QR

V1 ใช้ static opaque QR ต่อ registration

QR ห้าม encode personal data เช่น:

```txt
student_id
email
full_name
```

QR payload มี opaque token เท่านั้น เช่น:

```txt
ticket:v1:<opaque_random_token>
```

หรือ URL/payload ที่ scanner ส่ง backend ได้

## 11.2 QR Token Table

```ts
registration_qr_tokens {
  id uuid primary key
  registration_id uuid not null references registrations(id)
  token_hash text not null
  status enum('active', 'revoked') not null
  created_by_user_id uuid null references users(id)
  revoked_by_user_id uuid null references users(id)
  revoked_at timestamptz null
  created_at timestamptz not null
}
```

Rules:

* 1 registration มี active QR token ได้แค่ 1
* Admin regenerate/revoke QR ได้
* Student regenerate เองไม่ได้ใน V1
* Regenerate:

  * revoke token เก่า
  * generate token ใหม่
  * audit log
* Revoked token scan แล้วไม่ผ่าน
* Cancelled/waitlisted registration scan แล้ว backend reject ตาม status

## 11.3 Check-in Mode

V1 online-only

Staff scan QR แล้ว backend validate ทุกครั้ง

ถ้า network fail:

* ห้าม mark success
* UI ต้องบอกว่า check-in ยังไม่สำเร็จ
* ให้ลอง scan ใหม่

No offline mode in V1

## 11.4 Scan Endpoint

Example:

```http
POST /events/:eventId/checkins/scan
Content-Type: application/json

{
  "qr_token": "opaque_token"
}
```

Backend validate:

```txt
token exists
token active
registration belongs to event
event status allows check-in
checkin window open
registration status valid
not cancelled
not waitlisted
not already checked_in
```

On success:

```ts
registration.status = checked_in
registration.checked_in_at = now()
registration.checked_in_by_user_id = staff.id
registration.checkin_method = qr_scan
```

## 11.5 Check-in Scan Result Codes

```ts
type CheckinScanResult =
  | "checked_in_success"
  | "already_checked_in"
  | "wrong_event"
  | "registration_cancelled"
  | "waitlisted_not_allowed"
  | "checkin_not_open"
  | "checkin_closed"
  | "event_not_published"
  | "event_cancelled"
  | "qr_revoked"
  | "qr_invalid"
  | "network_error";
```

UI ต้องแสดงชัดเจน:

* success: ชื่อ, student_id, timestamp
* already checked-in: เวลาเดิม, checked_in_by
* wrong event: QR ของ event อื่น
* cancelled/waitlisted: ห้ามเข้า
* invalid/revoked: แนะนำ manual search fallback
* network error: ยังไม่ check-in ต้องลองใหม่

## 11.6 Manual Check-in

Staff manual search เฉพาะ registration ใน event นั้น

Staff ทำได้:

```txt
registered -> checked_in
checked_in -> registered // undo
```

Manual check-in ใช้เมื่อ:

* QR ใช้ไม่ได้
* มือถือแบตหมด
* scanner fail
* network/UI issue แต่ backend ยังใช้งานได้

Undo ต้องมี reason

Audit log:

```txt
manual_checkin
manual_checkin_undo
```

---

# 12. Import Users

## 12.1 Import File Types

Admin import users ผ่าน:

```txt
CSV
XLSX
```

## 12.2 Required Columns

```txt
student_id
email
full_name
```

## 12.3 Optional Columns

```txt
faculty
department
phone
```

## 12.4 Validate-first Flow

Import ต้อง validate-first + preview ก่อน confirm

Flow:

1. Admin upload CSV/XLSX
2. System parse
3. Show preview
4. Row status:

   * `will_create`
   * `will_update`
   * `invalid`
   * `duplicate_in_file`
   * `duplicate_email`
   * `duplicate_student_id`
   * `will_register_over_capacity`
5. Admin confirm
6. System create/update
7. Generate temp password เฉพาะ created users หรือ users ที่ admin เลือก reset
8. Export import result ได้

## 12.5 Import Behavior

```ts
if student_id exists:
  update existing user profile
else:
  create new user + generate temp password
```

Existing user จะไม่ reset password อัตโนมัติ

## 12.6 Import Scope

V1 รองรับ 2 mode:

```ts
import_scope:
  user_pool_only
  user_pool_and_register_to_event
```

### user_pool_only

* create/update user เท่านั้น
* ไม่ create registration

### user_pool_and_register_to_event

* create/update user
* create registration ให้ event
* ถ้ามี registration อยู่แล้ว ไม่สร้างซ้ำ
* ถ้า event registration ปิดอยู่ ถือเป็น admin override
* ต้อง audit log

## 12.7 Import Over Capacity

ถ้า import register แล้ว event เต็ม:

* preview row status = `will_register_over_capacity`
* admin เห็น warning
* ถ้า confirm:

  * create registration status = `registered`
  * capacity count เกินได้
  * ไม่ส่งเข้า waitlist อัตโนมัติ
  * audit log `admin_register_over_capacity`

---

# 13. Admin Dashboard

Admin dashboard แยก 3 ระดับ

## 13.1 Event Overview

แสดง:

```txt
registered count
checked-in count
cancelled count
waitlisted count
capacity used
registration window status
check-in window status
event status
visibility
```

## 13.2 Registration List

แสดง:

```txt
student_id
full_name
faculty
department
registration_status
registered_at
checked_in_at
checked_in_by
form_version
```

Actions:

```txt
view detail
cancel
override
promote/demote waitlist
reset QR
```

## 13.3 Registration Detail

แสดง:

```txt
user profile
registration status
form answers
uploaded file download
QR token status
audit history for this registration
```

---

# 14. Export

Admin export ได้ทั้ง:

```txt
CSV
XLSX
```

Export scope V1:

```ts
export_type:
  registrations_summary
  registrations_full
  checkin_attendance
```

## 14.1 registrations_summary

Columns:

```txt
student_id
full_name
faculty
department
registration_status
registered_at
checked_in_at
checked_in_by
```

## 14.2 registrations_full

Columns:

```txt
student_id
full_name
email
faculty
department
phone
registration_status
registered_at
checked_in_at
form_version
form_answers...
uploaded_file_name
uploaded_file_id_or_secure_link
```

## 14.3 checkin_attendance

Columns:

```txt
student_id
full_name
registration_status
checkin_method
checked_in_at
checked_in_by
manual_checkin_reason
```

## 14.4 Export Filters

Admin เลือก filter ได้:

```txt
status
date_range
form_version
```

Uploaded file ใน export:

* ใส่ `file_id` หรือ secure download link
* ไม่แนบ file binary ลง Excel

Export sensitive data ต้อง audit log

---

# 15. Audit Log

## 15.1 Audit Log Table

ใช้ table กลางเดียว แบบ append-only

```ts
audit_logs {
  id uuid primary key

  actor_user_id uuid null references users(id)
  actor_role text null

  action text not null
  entity_type text not null
  entity_id uuid null

  event_id uuid null references events(id)
  registration_id uuid null references registrations(id)
  target_user_id uuid null references users(id)

  old_value jsonb null
  new_value jsonb null

  reason text null
  metadata jsonb null

  ip_address text null
  user_agent text null

  created_at timestamptz not null
}
```

## 15.2 Audit Log Rules

* append-only
* ห้าม update/delete ผ่าน UI
* Admin ดู audit log ได้
* Staff ไม่เห็น audit log ทั้งหมด
* sensitive/secret values ต้อง redact

## 15.3 Audit Actions

Examples:

```txt
event_status_changed
event_visibility_changed
event_slug_changed

registration_created
registration_cancelled
registration_re_registered
registration_promoted_from_waitlist
registration_demoted_to_waitlist
admin_register_over_capacity

manual_checkin
manual_checkin_undo
qr_scan_checkin

qr_regenerated
qr_revoked

admin_password_reset
temp_password_exported
admin_unlocked_account

users_imported
user_created
user_profile_updated
user_disabled
user_enabled
user_role_changed

registration_exported
uploaded_file_downloaded

form_version_created
admin_edit_registration_answer

login_failed_rate_limited
account_temporarily_locked
```

## 15.4 Sensitive Data Redaction

Audit log ห้ามเก็บ:

```txt
plain_password
temporary_password
password_hash
qr_token_plain
encrypted_temp_password
file_content
uploaded_file_raw
session_token
reset_token
```

For temp password export, log only:

```json
{
  "exported_user_count": 120
}
```

ไม่เก็บ temp password จริงใน audit log

---

# 16. Public Pages

## 16.1 Public Event List

แสดง events ตาม rule:

```txt
published + listed -> show
cancelled + listed -> show with Cancelled badge
archived -> hide from list
draft -> hide from list
unlisted -> hide from list
```

## 16.2 Public Event Page

Show:

```txt
title
description
location
event time
registration status/window
capacity status
event status badge
register/join waitlist button where allowed
```

Behavior:

### draft

* not public

### published

* show normal page
* register allowed according to mode/window/capacity

### cancelled

* show cancelled clearly
* no register
* no waitlist
* no check-in

### archived

* direct link read-only
* no register
* no waitlist
* no check-in

---

# 17. Student Account Pages

Student pages:

## 17.1 My Events

Show registrations:

```txt
event title
event date
registration status
checked_in_at
cancelled_at
waitlisted_at
```

Include archived/cancelled events if student registered/waitlisted before

## 17.2 Event Registration Detail

Show:

```txt
event info
registration status
QR ticket if eligible
form answers
uploaded files
edit/cancel buttons if allowed
```

QR ticket should not show if:

```txt
cancelled
waitlisted
event cancelled
```

or can show but backend still rejects. Recommended UI: hide/disable with explanation.

---

# 18. Check-in Staff Pages

## 18.1 Event Check-in List

Staff sees check-in-capable events globally

Show:

```txt
event title
event date
check-in window
status
checked-in count
registered count
```

## 18.2 Scanner Page

Features:

```txt
QR scanner
manual search
recent scan result
network error display
```

## 18.3 Manual Search

Search scope:

```txt
registration within current event only
```

Search fields:

```txt
student_id
full_name
faculty?
department?
```

Result shows minimal info only

Actions:

```txt
manual check-in
undo check-in
```

---

# 19. Admin User Management

Admin actions:

```txt
create_user
import_users
edit_user_profile
disable_user
enable_user
reset_password
export_temp_passwords_for_pending_users
change_user_role
```

Rules:

* no hard delete user in V1
* disable user revokes/invalidates sessions
* disabled user cannot login
* registration/history/audit remain
* change role must audit log
* edit email/student_id must validate unique and audit log

---

# 20. System-wide Non-goals for V1

V1 will not include:

```txt
multi-tenant organization support
email service
magic link / OTP
self-service forgot password
offline check-in
auto-promote waitlist
remember me checkbox
hard delete users/events/registrations/files via UI
per-event staff assignment
student QR regenerate
slug history
file types beyond PDF/JPG/PNG by default
draft/save-later form submission
super admin / event admin split
```

---

# 21. Recommended Backend Modules

Suggested module split:

```txt
auth
sessions
users
events
registrations
forms
uploads
qr-tokens
checkins
imports
exports
audit-logs
storage
```

## 21.1 Permission Functions

Do not hardcode role checks everywhere. Use permission functions:

```ts
canManageUsers(user)
canManageEvents(user)
canExportRegistrations(user)
canResetPassword(user)
canViewAuditLogs(user)
canScanCheckin(user)
canManualCheckin(user)
canViewUploadedFile(user, file)
canEditRegistrationAnswer(user, registration)
```

---

# 22. Core API Sketch

## Auth

```http
POST /auth/login
POST /auth/logout
POST /auth/change-password
GET  /auth/me
```

## Users Admin

```http
GET    /admin/users
POST   /admin/users
GET    /admin/users/:userId
PATCH  /admin/users/:userId
POST   /admin/users/:userId/disable
POST   /admin/users/:userId/enable
POST   /admin/users/:userId/reset-password
POST   /admin/users/:userId/unlock
POST   /admin/users/:userId/change-role
GET    /admin/users/temp-passwords/export
```

## Events

```http
GET    /events
GET    /events/:slug
GET    /e/:publicId

GET    /admin/events
POST   /admin/events
GET    /admin/events/:eventId
PATCH  /admin/events/:eventId
POST   /admin/events/:eventId/status
POST   /admin/events/:eventId/visibility
```

## Forms

```http
GET    /admin/events/:eventId/form
PATCH  /admin/events/:eventId/form
POST   /admin/events/:eventId/form/version
```

## Registration

```http
POST   /events/:eventId/register
POST   /events/:eventId/join-waitlist
POST   /registrations/:registrationId/cancel
PATCH  /registrations/:registrationId/answers
GET    /me/registrations
GET    /me/registrations/:registrationId
```

## Admin Registration

```http
GET    /admin/events/:eventId/registrations
GET    /admin/registrations/:registrationId
POST   /admin/events/:eventId/registrations
POST   /admin/registrations/:registrationId/cancel
POST   /admin/registrations/:registrationId/promote
POST   /admin/registrations/:registrationId/demote
PATCH  /admin/registrations/:registrationId/answers
POST   /admin/registrations/:registrationId/qr/regenerate
POST   /admin/registrations/:registrationId/qr/revoke
```

## Check-in

```http
GET    /staff/events
GET    /staff/events/:eventId/checkin
POST   /events/:eventId/checkins/scan
GET    /events/:eventId/checkins/search
POST   /registrations/:registrationId/manual-checkin
POST   /registrations/:registrationId/undo-checkin
```

## Uploads

```http
POST   /registrations/:registrationId/files
GET    /files/:fileId/download
```

## Import / Export

```http
POST   /admin/imports/users/preview
POST   /admin/imports/users/confirm
GET    /admin/imports/:importId/result

GET    /admin/events/:eventId/export/registrations-summary
GET    /admin/events/:eventId/export/registrations-full
GET    /admin/events/:eventId/export/checkin-attendance
```

## Audit

```http
GET /admin/audit-logs
GET /admin/registrations/:registrationId/audit-logs
```

---

# 23. Critical Edge Cases

## 23.1 Capacity race

Must use transaction/locking.

## 23.2 User changes email/student_id

Registration remains valid because it references `user_id`.

## 23.3 Admin changes event slug

Pretty URL changes. Old slug breaks. QR still works because QR uses `/e/:public_id`.

## 23.4 QR leaked/shared

Admin can regenerate/revoke QR. Old token fails.

## 23.5 Staff network fail during scan

Do not mark success. Show network error. Retry.

## 23.6 Form changed after registrations exist

Create new form version. Old registrations keep old version.

## 23.7 Student replaces uploaded file

Old file soft deleted and kept in history.

## 23.8 Event cancelled then republished

Data remains. Registration/check-in records remain. Status behavior updates based on current event status.

## 23.9 Admin import over capacity

Allowed with warning + audit log.

## 23.10 Temp password export after user changed password

Not possible. Temp password encrypted row is deleted after password change.

---

# 24. V1 Build Priority

Recommended implementation order:

## Phase 1 — Foundation

```txt
database schema
auth/session
roles/permissions
audit log
admin user management
temp password flow
```

## Phase 2 — Events

```txt
event CRUD
status/visibility
public event list/page
public_id + slug routing
registration/check-in windows
```

## Phase 3 — Forms & Registration

```txt
form builder
form versioning
registration submit
capacity/waitlist
student my events
student edit/cancel registration
```

## Phase 4 — Files

```txt
StorageProvider
local private storage
file upload field
file download permission
soft delete file lifecycle
```

## Phase 5 — Check-in

```txt
QR token generation
student QR page
scanner page
scan result codes
manual search/check-in
undo check-in
```

## Phase 6 — Import/Export

```txt
CSV/XLSX import preview
confirm import
temp password export
registration exports
attendance exports
```

## Phase 7 — Polish & Hardening

```txt
rate limit/lockout
admin dashboard overview
error states
network fail UX
audit log viewer
security review
```

---

# 25. Final V1 Decision Summary

Locked decisions:

```txt
Single internal site
3 roles: student, checkin_staff, admin
Global check-in staff access
UUID internal primary keys
student_id unique globally
email/password for all roles
No email service in V1
Admin-generated temp passwords
Encrypted temp password storage until user changes password
Server-side sessions
Role-based session TTL
Login rate limit + lockout
Admin-level role only, no super admin split
Events: draft/published/cancelled/archived
Event status changes are non-destructive
Visibility: listed/unlisted
Unlisted means hidden from list, direct link still works
Event QR uses permanent public_id URL
Slug editable, no slug history
Archived direct link read-only
Cancelled page visible until unlisted
Registration modes per event
Registration/check-in windows
Admin override with audit log
1 registration record per user per event
Registration statuses: registered/waitlisted/checked_in/cancelled
Capacity + optional waitlist
No auto-promote waitlist
Race-safe capacity registration
Google Forms-style fields
File upload in V1
Allowed files: PDF/JPG/PNG, 1 file, 5MB default
Form versioning
No draft form submission
Student edit/cancel configurable per event
Admin can edit answers with reason + audit log
Local private storage via StorageProvider
File soft delete + history
Student sees own files, Admin sees all, Staff sees none
Static opaque QR per registration
Admin can regenerate/revoke QR
Online-only check-in
Detailed scan result codes
CSV/XLSX import validate-first
Import modes: user pool only / user pool + register to event
CSV/XLSX export with selectable scope
Central append-only audit_logs
Audit log redacts secrets/sensitive values
No hard delete in V1
```
