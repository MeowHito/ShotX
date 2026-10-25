import type {
  DriveUsageResponse,
  ErrorCode,
  FileStatus,
  RejectedFileTypeHint,
  SubscriptionStatus,
} from '@shotx/shared';

/**
 * Thai UI copy (the default and, for now, only locale). Sections keyed by a shared enum use
 * `satisfies Record<…>` so adding a value in @shotx/shared fails typecheck until it has copy.
 * Placeholders use ICU syntax (next-intl).
 */

/** One message per API error code: the fallback when a code has no more specific message. */
const errorCodes = {
  QUOTA_EXCEEDED: 'พื้นที่จัดเก็บไม่พอ ลองลบไฟล์ในถังขยะหรืออัปเกรดแพ็กเกจ',
  SHARE_EXPIRED: 'ลิงก์นี้หมดอายุ',
  CONSENT_REQUIRED: 'กรุณายอมรับเงื่อนไขการใช้ข้อมูลใบหน้าก่อนสแกน',
  NO_FACE_DETECTED: 'ไม่พบใบหน้าในรูป กรุณาหันหน้าตรง ถอดแว่นดำหรือแมสก์ และอยู่ในที่สว่าง',
  RATE_LIMITED: 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  PAYLOAD_TOO_LARGE: 'ข้อมูลที่ส่งมีขนาดใหญ่เกินไป',
  UNSUPPORTED_FILE_TYPE: 'ไม่รองรับไฟล์ประเภทนี้ รองรับเฉพาะ JPEG, PNG, WebP, MP4 และ MOV',
  FILE_TOO_LARGE: 'ไฟล์มีขนาดใหญ่เกินกำหนด',
  VALIDATION_FAILED: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่',
  UNAUTHENTICATED: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง',
  FORBIDDEN: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
  NOT_FOUND: 'ไม่พบรายการนี้ อาจถูกลบหรือย้ายไปแล้ว',
  CONFLICT: 'รายการนี้เปลี่ยนไปแล้ว กรุณารีเฟรชแล้วลองใหม่',
  INTERNAL_ERROR: 'ระบบขัดข้อง กรุณาลองใหม่ภายหลัง',
  NAME_TAKEN: 'มีชื่อนี้อยู่แล้วในโฟลเดอร์นี้',
  INVALID_MOVE: 'ย้ายโฟลเดอร์ไปไว้ในตัวเองหรือในโฟลเดอร์ย่อยของตัวเองไม่ได้',
  FOLDER_DEPTH_EXCEEDED: 'โฟลเดอร์ซ้อนกันลึกเกินกำหนด',
  SUBSCRIPTION_INACTIVE: 'แพ็กเกจของคุณไม่ได้ใช้งานอยู่ จึงอัปโหลดไม่ได้ กรุณาต่ออายุแพ็กเกจ',
  UPLOAD_NOT_FOUND: 'ไม่พบการอัปโหลดนี้ กรุณาอัปโหลดใหม่',
  UPLOAD_EXPIRED: 'การอัปโหลดหมดเวลา กรุณาอัปโหลดใหม่',
  UPLOAD_PARTS_INVALID: 'ไฟล์ที่อัปโหลดไม่ครบหรือเสียหาย กรุณาอัปโหลดใหม่',
} as const satisfies Record<ErrorCode, string>;

/** Why HEIC and RAW files are rejected, and what to do instead. */
const fileTypeHints = {
  heic: 'ยังไม่รองรับไฟล์ HEIC กรุณาแปลงเป็น JPEG ก่อน หรือตั้งค่ากล้อง iPhone เป็น “รองรับมากที่สุด” (การตั้งค่า > กล้อง > รูปแบบ)',
  raw: 'ไม่รองรับไฟล์ RAW กรุณาส่งออกเป็น JPEG จากโปรแกรมแต่งภาพก่อนอัปโหลด',
} as const satisfies Record<RejectedFileTypeHint, string>;

const subscriptionStatus = {
  trial: 'ทดลองใช้',
  active: 'ใช้งานอยู่',
  grace: 'ช่วงผ่อนผัน',
  expired: 'หมดอายุ',
  purged: 'ลบข้อมูลแล้ว',
} as const satisfies Record<SubscriptionStatus, string>;

type UploadsBlockedBy = NonNullable<DriveUsageResponse['uploadsBlockedBy']>;

const uploadsBlocked = {
  SUBSCRIPTION_INACTIVE:
    'อัปโหลดไม่ได้ในขณะนี้ เพราะแพ็กเกจไม่ได้ใช้งานอยู่ ไฟล์และลิงก์แชร์เดิมยังใช้ได้ กรุณาต่ออายุแพ็กเกจเพื่ออัปโหลดต่อ',
  QUOTA_EXCEEDED:
    'พื้นที่จัดเก็บเต็มแล้ว อัปโหลดเพิ่มไม่ได้ ลบไฟล์ (รวมถึงล้างถังขยะ) หรืออัปเกรดแพ็กเกจ',
} as const satisfies Record<UploadsBlockedBy, string>;

const fileStatus = {
  uploading: 'กำลังอัปโหลด',
  processing: 'กำลังประมวลผล',
  ready: 'พร้อมใช้งาน',
  failed: 'ไฟล์ใช้ไม่ได้',
} as const satisfies Record<FileStatus, string>;

export const th = {
  metadata: {
    title: 'ShotX',
    description: 'ฝากรูปงานอีเวนต์ แชร์ลิงก์ และให้ผู้ร่วมงานค้นหารูปตัวเองด้วยใบหน้า',
  },
  common: {
    appName: 'ShotX',
    cancel: 'ยกเลิก',
    save: 'บันทึก',
    close: 'ปิด',
    loading: 'กำลังโหลด…',
    retry: 'ลองอีกครั้ง',
  },
  home: {
    heading: 'ฝากรูป แชร์ง่าย ค้นหาด้วยใบหน้า',
    body: 'อัปโหลดรูปและวิดีโอจากงานของคุณ จัดเป็นโฟลเดอร์ แล้วแชร์ลิงก์ให้ผู้ร่วมงาน',
    goToStudio: 'ไปที่สตูดิโอ',
    login: 'เข้าสู่ระบบ',
  },
  login: {
    title: 'เข้าสู่ระบบสำหรับช่างภาพ',
    subtitle: 'เลือกวิธีเข้าสู่ระบบ',
    google: 'เข้าสู่ระบบด้วย Google',
    line: 'เข้าสู่ระบบด้วย LINE',
    email: 'เข้าสู่ระบบด้วยอีเมล',
    errors: {
      cancelled: 'ยกเลิกการเข้าสู่ระบบแล้ว',
      failed: 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่',
      expired: 'หน้าเข้าสู่ระบบหมดเวลา กรุณาลองใหม่',
    },
  },
  studio: {
    drive: 'ไดรฟ์ของฉัน',
    trash: 'ถังขยะ',
    logout: 'ออกจากระบบ',
    navLabel: 'เมนูสตูดิโอ',
  },
  drive: {
    root: 'ไดรฟ์ของฉัน',
    breadcrumbLabel: 'ตำแหน่งโฟลเดอร์',
    newFolder: 'โฟลเดอร์ใหม่',
    uploadFiles: 'อัปโหลดไฟล์',
    uploadFolder: 'อัปโหลดโฟลเดอร์',
    empty: 'โฟลเดอร์นี้ยังว่างอยู่',
    emptyHint: 'ลากไฟล์หรือโฟลเดอร์มาวางที่นี่ หรือกดอัปโหลด',
    dropHere: 'ปล่อยเพื่ออัปโหลดมาที่โฟลเดอร์นี้',
    loadingMore: 'กำลังโหลดเพิ่ม…',
    loadError: 'โหลดรายการไม่สำเร็จ',
    itemActions: 'ตัวเลือกของ {name}',
    select: 'เลือก {name}',
    selectedCount: 'เลือกแล้ว {count, number} รายการ',
    clearSelection: 'ยกเลิกการเลือก',
    rename: 'เปลี่ยนชื่อ',
    move: 'ย้าย',
    moveToTrash: 'ย้ายไปถังขยะ',
    trashed: 'ย้าย {count, number} รายการไปถังขยะแล้ว',
    moved: 'ย้าย {count, number} รายการแล้ว',
    video: 'วิดีโอ',
    folder: 'โฟลเดอร์',
    fileStatus,
  },
  createFolder: {
    title: 'สร้างโฟลเดอร์ใหม่',
    nameLabel: 'ชื่อโฟลเดอร์',
    placeholder: 'เช่น งานวิ่ง 2569',
    submit: 'สร้าง',
  },
  rename: {
    title: 'เปลี่ยนชื่อ',
    nameLabel: 'ชื่อใหม่',
    submit: 'บันทึก',
  },
  move: {
    title: 'ย้าย {count, number} รายการไปที่',
    here: 'ย้ายมาที่นี่',
    noSubfolders: 'ไม่มีโฟลเดอร์ย่อย',
    openFolder: 'เปิดโฟลเดอร์ {name}',
    beingMoved: 'กำลังย้ายรายการนี้',
    partialFailure: 'ย้ายไม่สำเร็จ {count, number} รายการ: {reason}',
  },
  validation: {
    invalidName: 'ชื่อนี้ใช้ไม่ได้ ห้ามเว้นว่าง ห้ามมี / หรือ \\ และยาวได้ไม่เกิน 255 ไบต์',
    extensionChanged: 'ต้องคงนามสกุลไฟล์ให้ตรงกับชนิดไฟล์เดิม (เช่น .jpg)',
  },
  trash: {
    title: 'ถังขยะ',
    description: 'รายการในถังขยะยังนับรวมในพื้นที่ใช้งาน จนกว่าจะถูกลบถาวร',
    restore: 'กู้คืน',
    restored: 'กู้คืน {count, number} รายการแล้ว',
    emptyTrash: 'ล้างถังขยะ',
    confirmTitle: 'ลบทุกอย่างในถังขยะถาวร?',
    confirmBody: 'ไฟล์และโฟลเดอร์ทั้งหมดในถังขยะจะถูกลบถาวรและกู้คืนไม่ได้',
    confirm: 'ลบถาวร',
    emptied: 'ลบถาวร {files, number} ไฟล์และ {folders, number} โฟลเดอร์ ได้พื้นที่คืน {bytes}',
    isEmpty: 'ถังขยะว่าง',
    purgeAt: 'ลบถาวร {date}',
  },
  usage: {
    label: 'พื้นที่ใช้งาน',
    summary: 'ใช้ไป {used} จาก {quota}',
    reserved: 'กำลังอัปโหลด {bytes}',
    trash: 'อยู่ในถังขยะ {bytes}',
    noPlan: 'ยังไม่มีแพ็กเกจ',
    plan: 'แพ็กเกจ {plan} · {status} ถึง {date}',
    subscriptionStatus,
    blocked: uploadsBlocked,
  },
  upload: {
    title: 'อัปโหลด',
    summary: 'เสร็จแล้ว {done, number} จาก {total, number} ไฟล์',
    cancel: 'ยกเลิกการอัปโหลด {name}',
    retry: 'ลองอัปโหลด {name} ใหม่',
    dismiss: 'ล้างรายการที่เสร็จแล้ว',
    status: {
      queued: 'รอคิว',
      uploading: '{percent, number}%',
      complete: 'เสร็จแล้ว',
      error: 'ไม่สำเร็จ',
      rejected: 'ไม่ได้อัปโหลด',
    },
  },
  errors: {
    codes: errorCodes,
    hints: fileTypeHints,
    details: {
      quotaExceeded: 'พื้นที่ไม่พอ ไฟล์นี้ต้องใช้ {requested} แต่เหลือ {available}',
      fileTooLarge: 'ไฟล์ใหญ่เกินกำหนด (สูงสุด {max})',
      unsupportedExtension: 'ไม่รองรับไฟล์ .{extension} รองรับเฉพาะ JPEG, PNG, WebP, MP4 และ MOV',
      folderNameTaken: 'มีโฟลเดอร์ชื่อ “{name}” อยู่แล้วที่นี่',
      fileNameTaken: 'มีไฟล์ชื่อ “{name}” อยู่แล้วที่นี่',
      folderDepthExceeded: 'โฟลเดอร์ซ้อนกันได้ไม่เกิน {max, number} ชั้น',
      subscriptionNone: 'ยังไม่มีแพ็กเกจ เลือกแพ็กเกจเพื่อเริ่มอัปโหลด',
      subscriptionStatus: 'แพ็กเกจอยู่ในสถานะ “{status}” จึงอัปโหลดไม่ได้ กรุณาต่ออายุแพ็กเกจ',
    },
    client: {
      network: 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง',
      contract: 'ระบบตอบกลับไม่ถูกต้อง กรุณาลองใหม่',
      unknown: 'เกิดข้อผิดพลาด กรุณาลองใหม่',
      emptyFile: 'ไฟล์นี้ว่างเปล่า',
      invalidRelativePath: 'ชื่อโฟลเดอร์ในเส้นทาง “{path}” ใช้ไม่ได้',
      uploadPlanMismatch: 'การตั้งค่าการอัปโหลดไม่ตรงกับเซิร์ฟเวอร์ กรุณารีเฟรชหน้าแล้วลองใหม่',
      storageUpload: 'ส่งไฟล์ไปยังที่จัดเก็บไม่สำเร็จ กรุณาลองใหม่',
    },
  },
} as const;

export type Messages = typeof th;
