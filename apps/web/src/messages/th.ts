import type {
  BillingMode,
  BillingNoticeCode,
  CheckoutChangeType,
  ConsentPolicyVersion,
  ConsentPurpose,
  DownloadSize,
  DriveUsageResponse,
  ErrorCode,
  FileStatus,
  PaymentStatus,
  PlanChangeInvalidReason,
  RejectedFileTypeHint,
  ShareMode,
  ShareStatus,
  ShareUnavailableReason,
  SubscriptionStatus,
  ZipJobViewStatus,
} from '@shotx/shared';
import type { SelfieAngle, SelfieIssue } from '../lib/face/quality-gate';

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
  IDEMPOTENCY_KEY_REUSED: 'คำขอนี้ซ้ำกับคำขอก่อนหน้าแต่ข้อมูลไม่ตรงกัน กรุณาลองใหม่อีกครั้ง',
  LOGIN_REQUIRED: 'ลิงก์นี้ต้องเข้าสู่ระบบก่อนจึงจะดูรูปได้',
  PASSWORD_REQUIRED: 'ลิงก์นี้ต้องใส่รหัสผ่านก่อนจึงจะดูรูปได้',
  PASSWORD_INCORRECT: 'รหัสผ่านไม่ถูกต้อง',
  CONSENT_VERSION_MISMATCH:
    'ข้อความขอความยินยอมใช้ข้อมูลใบหน้ามีการปรับปรุง กรุณาอ่านและยอมรับอีกครั้ง',
  DOWNLOAD_NOT_ALLOWED: 'ช่างภาพไม่อนุญาตให้ดาวน์โหลดรูปจากลิงก์นี้',
  ZIP_TOO_LARGE: 'เลือกไฟล์มากเกินไปสำหรับการดาวน์โหลดครั้งเดียว กรุณาเลือกให้น้อยลง',
  FEATURE_DISABLED: 'ฟีเจอร์นี้ยังไม่เปิดให้ใช้งาน',
  FACE_SEARCH_UNAVAILABLE: 'ลิงก์นี้ยังค้นหารูปด้วยใบหน้าไม่ได้',
  PLAN_NOT_FOUND: 'ไม่พบแพ็กเกจนี้ หรือแพ็กเกจนี้ไม่เปิดขายแล้ว กรุณาเลือกแพ็กเกจใหม่',
  PLAN_CHANGE_INVALID: 'เปลี่ยนแพ็กเกจแบบนี้ไม่ได้ในขณะนี้ กรุณารีเฟรชหน้าแล้วลองใหม่',
  CHECKOUT_PENDING:
    'มีรายการชำระเงินที่ยังรอชำระอยู่ กรุณาชำระรายการนั้นให้เสร็จ หรือรอให้หมดเวลาก่อนเริ่มรายการใหม่',
  CHECKOUT_EXPIRED: 'รายการชำระเงินนี้หมดเวลาแล้ว กรุณาเริ่มชำระเงินใหม่อีกครั้ง',
  WEBHOOK_SIGNATURE_INVALID: 'ยืนยันข้อมูลการชำระเงินจากผู้ให้บริการไม่ได้',
  PAYMENT_GATEWAY_ERROR: 'ระบบชำระเงินขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งในอีกสักครู่',
} as const satisfies Record<ErrorCode, string>;

/** Why a checkout was refused (PLAN_CHANGE_INVALID details.reason). */
const planChangeReasons = {
  change_type_mismatch:
    'สถานะแพ็กเกจของคุณเปลี่ยนไปแล้ว กรุณาตรวจสอบรายละเอียดอีกครั้งก่อนชำระเงิน',
  pending_change_exists:
    'คุณมีการลดแพ็กเกจที่รอมีผลอยู่ จึงเปลี่ยนแพ็กเกจอื่นไม่ได้จนกว่าจะถึงวันที่มีผล',
  auto_renew_active: 'แพ็กเกจนี้ต่ออายุอัตโนมัติด้วยบัตรอยู่แล้ว ไม่ต้องชำระซ้ำ',
  card_downgrade_needs_auto_renew:
    'ลดแพ็กเกจด้วยบัตรได้เฉพาะเมื่อเปิดต่ออายุอัตโนมัติอยู่ กรุณาเลือกชำระด้วยพร้อมเพย์',
  months_required: 'กรุณาเลือกจำนวนเดือนที่ต้องการชำระ',
  months_not_allowed: 'การอัปเกรดชำระเฉพาะส่วนต่างตามจำนวนวันที่เหลือ ไม่ต้องเลือกจำนวนเดือน',
  months_not_offered: 'ไม่มีตัวเลือกจำนวนเดือนนี้ กรุณาเลือกใหม่',
} as const satisfies Record<PlanChangeInvalidReason, string>;

/** Informational codes in billing responses (`notices`). */
const billingNotices = {
  DOWNGRADE_EXCEEDS_QUOTA:
    'แพ็กเกจใหม่มีพื้นที่ {quota} แต่ตอนนี้คุณใช้อยู่ {used} (เกิน {over}) ตั้งแต่วันที่ลดแพ็กเกจจะอัปโหลดเพิ่มไม่ได้จนกว่าจะลบไฟล์ให้พอดีกับพื้นที่ ระบบจะไม่ลบไฟล์ของคุณเอง',
} as const satisfies Record<BillingNoticeCode, string>;

/**
 * Consent texts, one per CONSENT_PURPOSES purpose and CONSENT_POLICY_VERSIONS version. A version's
 * text never changes once released: new wording means a new version in @shotx/shared. The
 * face-search text states how long results are kept (`{ttl}`, from the API's
 * SHARE_FACE_ONLY_GRANT_TTL_SECONDS in share meta). The DPO or legal team approves each version
 * before launch.
 */
interface ConsentPolicyText {
  title: string;
  intro: string;
  points: {
    purpose: string;
    noStorage: string;
    results: string;
    processor: string;
    withdraw: string;
  };
  checkbox: string;
}

const consentPolicies = {
  face_search: {
    '2026-10-25': {
      title: 'ขอความยินยอมใช้ข้อมูลใบหน้า',
      intro:
        'การค้นหารูปด้วยใบหน้าต้องใช้ภาพใบหน้าของคุณ ซึ่งเป็นข้อมูลชีวภาพ และเป็นข้อมูลส่วนบุคคลที่มีความอ่อนไหวตามมาตรา 26 แห่งพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 เราจึงขอความยินยอมจากคุณก่อน',
      points: {
        purpose:
          'เราใช้ภาพเซลฟีของคุณเพื่อเปรียบเทียบกับใบหน้าในรูปของลิงก์นี้เท่านั้น และไม่ใช้เพื่อวัตถุประสงค์อื่น',
        noStorage:
          'ภาพเซลฟีถูกประมวลผลในหน่วยความจำแล้วลบทิ้งทันที ไม่มีการบันทึกภาพเซลฟีไว้ในเครื่องของคุณหรือในระบบของเรา',
        results:
          'ผลการค้นหา (รายการรูปที่ตรงกับคุณ) เก็บไว้ไม่เกิน {ttl} เพื่อให้คุณเปิดดูและดาวน์โหลดรูปได้',
        processor:
          'การเปรียบเทียบใบหน้าทำโดยผู้ให้บริการประมวลผลข้อมูลของเรา (Amazon Web Services) ในภูมิภาคสิงคโปร์',
        withdraw:
          'คุณถอนความยินยอมได้ทุกเมื่อจากหน้านี้ และขอให้ลบใบหน้าของคุณออกจากระบบค้นหาของช่างภาพได้ที่ “ขอลบใบหน้าของฉัน”',
      },
      checkbox: 'ฉันได้อ่านและยินยอมให้ใช้ภาพใบหน้าของฉันเพื่อค้นหารูปตามข้อความข้างต้น',
    },
  },
  face_deletion: {
    '2026-10-25': {
      title: 'ขอความยินยอมใช้ข้อมูลใบหน้าเพื่อลบใบหน้าของคุณ',
      intro:
        'การลบใบหน้าของคุณออกจากระบบค้นหาต้องใช้ภาพใบหน้าของคุณเพื่อหาใบหน้าที่ตรงกัน ซึ่งเป็นข้อมูลชีวภาพ และเป็นข้อมูลส่วนบุคคลที่มีความอ่อนไหวตามมาตรา 26 แห่งพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 เราจึงขอความยินยอมจากคุณก่อน',
      points: {
        purpose:
          'เราใช้ภาพเซลฟีของคุณเพื่อค้นหาใบหน้าของคุณในรูปทั้งหมดของช่างภาพรายนี้ แล้วลบใบหน้าที่พบออกจากระบบค้นหาเท่านั้น และไม่ใช้เพื่อวัตถุประสงค์อื่น',
        noStorage:
          'ภาพเซลฟีถูกประมวลผลในหน่วยความจำแล้วลบทิ้งทันที ไม่มีการบันทึกภาพเซลฟีไว้ในเครื่องของคุณหรือในระบบของเรา',
        results:
          'ระบบแจ้งเพียงจำนวนใบหน้าที่พบ ไม่แสดงรูปใด ๆ รูปถ่ายยังอยู่ตามเดิม แต่ใบหน้าที่ลบแล้วจะค้นหาด้วยใบหน้าไม่ได้อีก และย้อนกลับไม่ได้',
        processor:
          'การเปรียบเทียบใบหน้าทำโดยผู้ให้บริการประมวลผลข้อมูลของเรา (Amazon Web Services) ในภูมิภาคสิงคโปร์',
        withdraw:
          'คุณถอนความยินยอมได้ทุกเมื่อ การถอนความยินยอมไม่ทำให้ใบหน้าที่ลบไปแล้วกลับมาในระบบค้นหา',
      },
      checkbox:
        'ฉันได้อ่านและยินยอมให้ใช้ภาพใบหน้าของฉันเพื่อค้นหาและลบใบหน้าของฉันตามข้อความข้างต้น',
    },
  },
} as const satisfies Record<ConsentPurpose, Record<ConsentPolicyVersion, ConsentPolicyText>>;

const shareStatus = {
  active: 'ใช้งานอยู่',
  expired: 'หมดอายุ',
  revoked: 'ยกเลิกแล้ว',
} as const satisfies Record<ShareStatus, string>;

const shareModes = {
  gallery: 'แกลเลอรี: ทุกคนที่มีลิงก์เห็นรูปทั้งหมด',
  face_only: 'เฉพาะรูปของตัวเอง: ผู้ชมต้องสแกนใบหน้าก่อน และเห็นเฉพาะรูปที่มีตัวเอง',
} as const satisfies Record<ShareMode, string>;

const downloadSizes = {
  web: 'ขนาดสำหรับโซเชียล',
  original: 'ไฟล์ต้นฉบับ',
} as const satisfies Record<DownloadSize, string>;

const shareUnavailableReasons = {
  revoked: 'ช่างภาพยกเลิกลิงก์นี้แล้ว',
  expired: 'ลิงก์นี้เลยวันหมดอายุแล้ว',
  unavailable: 'รูปในลิงก์นี้ไม่เปิดให้ดูแล้ว',
} as const satisfies Record<ShareUnavailableReason, string>;

const selfieIssues = {
  unreadable: 'อ่านรูปนี้ไม่ได้ กรุณาถ่ายใหม่',
  noFace: 'ไม่พบใบหน้า กรุณาหันหน้าตรง ถอดแว่นดำ/แมสก์ และอยู่ในที่สว่าง',
  multipleFaces: 'พบใบหน้ามากกว่าหนึ่งคน กรุณาถ่ายให้มีแค่คุณคนเดียวในรูป',
  tooSmall: 'ใบหน้าเล็กเกินไป กรุณาถือกล้องให้ใกล้ขึ้น',
  notFrontal: 'กรุณาหันหน้าตรงเข้าหากล้อง',
  tooDark: 'รูปมืดเกินไป กรุณาไปอยู่ในที่สว่าง',
  tooBright: 'รูปสว่างจ้าเกินไป กรุณาหลบแสงที่ส่องเข้าหน้าโดยตรง',
} as const satisfies Record<SelfieIssue, string>;

const selfieAngles = {
  front: 'หน้าตรง',
  left: 'หันซ้ายเล็กน้อย',
  right: 'หันขวาเล็กน้อย',
} as const satisfies Record<SelfieAngle, string>;

const zipStatus = {
  queued: 'กำลังรอคิวเตรียมไฟล์ zip…',
  running: 'กำลังรวมรูปเป็นไฟล์ zip…',
  ready: 'ไฟล์ zip พร้อมแล้ว กำลังเริ่มดาวน์โหลด',
  failed: 'เตรียมไฟล์ zip ไม่สำเร็จ กรุณาลองใหม่',
  expired: 'ไฟล์ zip หมดอายุแล้ว กรุณากดดาวน์โหลดใหม่',
} as const satisfies Record<ZipJobViewStatus, string>;

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

const changeTypes = {
  new: 'เริ่มแพ็กเกจ',
  renew: 'ต่ออายุ',
  upgrade: 'อัปเกรด',
  downgrade: 'ลดแพ็กเกจ',
} as const satisfies Record<CheckoutChangeType, string>;

/** What each kind of plan change does, shown before paying. */
const changeExplanations = {
  new: 'แพ็กเกจเริ่มทันทีหลังชำระเงินสำเร็จ',
  renew:
    'ต่ออายุแพ็กเกจเดิม ระยะเวลาที่ซื้อจะนับต่อจากวันหมดอายุเดิม (หรือนับจากวันนี้ หากแพ็กเกจหมดอายุเกินช่วงผ่อนผันแล้ว)',
  upgrade:
    'อัปเกรดมีผลทันทีหลังชำระเงิน พื้นที่เพิ่มขึ้นทันที และชำระเฉพาะส่วนต่างของราคาตามจำนวนวันที่เหลือในรอบปัจจุบัน วันหมดอายุเท่าเดิม',
  downgrade:
    'การลดแพ็กเกจมีผลเมื่อครบรอบปัจจุบัน ({date}) จนถึงวันนั้นยังใช้แพ็กเกจเดิมได้ตามปกติ หากไฟล์ที่เก็บไว้เกินพื้นที่ของแพ็กเกจใหม่ จะอัปโหลดเพิ่มไม่ได้จนกว่าจะลบไฟล์ให้พอดี ระบบจะไม่ลบไฟล์ของคุณ',
} as const satisfies Record<CheckoutChangeType, string>;

const paymentStatus = {
  pending: 'รอชำระเงิน',
  paid: 'ชำระเงินแล้ว',
  failed: 'ชำระเงินไม่สำเร็จ',
  expired: 'หมดเวลาชำระเงิน',
  refunded: 'คืนเงินแล้ว',
} as const satisfies Record<PaymentStatus, string>;

const billingModes = {
  prepaid: 'ชำระล่วงหน้า ไม่ต่ออายุอัตโนมัติ',
  auto_renew: 'ต่ออายุอัตโนมัติด้วยบัตร',
} as const satisfies Record<BillingMode, string>;

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
    duration: {
      hours: '{count, number} ชั่วโมง',
      minutes: '{count, number} นาที',
    },
  },
  home: {
    heading: 'ฝากรูป แชร์ง่าย ค้นหาด้วยใบหน้า',
    body: 'อัปโหลดรูปและวิดีโอจากงานของคุณ จัดเป็นโฟลเดอร์ แล้วแชร์ลิงก์ให้ผู้ร่วมงาน',
    goToStudio: 'ไปที่สตูดิโอ',
    login: 'เข้าสู่ระบบ',
    pricing: 'ดูแพ็กเกจและราคา',
  },
  pricing: {
    title: 'แพ็กเกจและราคา',
    subtitle: 'เลือกพื้นที่จัดเก็บให้พอดีกับงานของคุณ เปลี่ยนแพ็กเกจได้ทุกเมื่อ',
    interval: 'รอบการชำระ',
    monthly: 'รายเดือน',
    yearly: 'รายปี',
    perMonth: '{price} / เดือน',
    perYear: '{price} / ปี',
    storage: 'พื้นที่จัดเก็บ {quota}',
    vatIncluded: 'ราคารวมภาษีมูลค่าเพิ่ม {rate}% แล้ว',
    vatPart: 'รวม VAT {vat}',
    payment:
      'ชำระด้วยพร้อมเพย์ล่วงหน้า {months} เดือน หรือบัตรเครดิต/เดบิตแบบต่ออายุอัตโนมัติรายเดือนหรือรายปี',
    choose: 'เลือกแพ็กเกจ {plan}',
    trial: 'เริ่มทดลองใช้ฟรีได้ทันที ไม่ต้องผูกบัตร',
    startTrial: 'เริ่มทดลองใช้ฟรี',
    loadError: 'โหลดราคาแพ็กเกจไม่สำเร็จ กรุณาลองใหม่ภายหลัง',
    empty: 'ยังไม่มีแพ็กเกจเปิดขายในขณะนี้',
    listLabel: 'รายการแพ็กเกจ',
  },
  billing: {
    title: 'แพ็กเกจและการชำระเงิน',
    current: {
      heading: 'แพ็กเกจปัจจุบัน',
      none: 'ยังไม่มีแพ็กเกจ เลือกแพ็กเกจด้านล่างเพื่อเริ่มใช้งาน',
      plan: 'แพ็กเกจ',
      status: 'สถานะ',
      quota: 'พื้นที่',
      periodEnd: 'ใช้ได้ถึง',
      renewal: 'การต่ออายุ',
      modes: billingModes,
      autoRenewEvery:
        '{months, plural, =1 {ต่ออายุอัตโนมัติด้วยบัตรทุกเดือน} =12 {ต่ออายุอัตโนมัติด้วยบัตรทุกปี} other {ต่ออายุอัตโนมัติด้วยบัตรทุก # เดือน}}',
      canceled: 'ยกเลิกการต่ออายุอัตโนมัติแล้ว แพ็กเกจใช้ได้ถึง {date}',
      nextRenewal: 'ตัดบัตรครั้งถัดไป {date}: แพ็กเกจ {plan} {price}',
      pendingDowngrade: 'ลดเป็นแพ็กเกจ {plan} ({quota}) ตั้งแต่ {date}',
      cancelAutoRenew: 'ยกเลิกการต่ออายุอัตโนมัติ',
      cancelTitle: 'ยกเลิกการต่ออายุอัตโนมัติ?',
      cancelBody:
        'ระบบจะไม่ตัดบัตรอีกและจะเลิกใช้บัตรที่บันทึกไว้ แพ็กเกจยังใช้ได้ถึง {date} หลังจากนั้นต่ออายุด้วยพร้อมเพย์หรือบัตรได้ทุกเมื่อ',
      cancelConfirm: 'ยืนยันการยกเลิก',
      cancelKeep: 'ไม่ยกเลิก',
      canceledDone: 'ยกเลิกการต่ออายุอัตโนมัติแล้ว',
      loadError: 'โหลดข้อมูลแพ็กเกจไม่สำเร็จ',
    },
    banners: {
      trial: 'คุณกำลังทดลองใช้ฟรีถึง {date} เลือกแพ็กเกจเพื่อใช้งานต่อได้โดยไม่สะดุด',
      grace:
        'แพ็กเกจหมดอายุแล้ว อัปโหลดไม่ได้ชั่วคราว แต่ลิงก์แชร์และการดาวน์โหลดยังใช้ได้ ต่ออายุภายใน {date} ก่อนลิงก์แชร์ทั้งหมดจะหมดอายุ',
      expired:
        'แพ็กเกจหมดอายุแล้ว ลิงก์แชร์ทั้งหมดเปิดไม่ได้ คุณยังเข้าสู่ระบบและดาวน์โหลดไฟล์ของตัวเองได้ ต่ออายุก่อน {date} มิฉะนั้นไฟล์ทั้งหมดจะถูกลบถาวร',
      purged: 'ไฟล์ของแพ็กเกจเดิมถูกลบแล้ว เลือกแพ็กเกจเพื่อเริ่มใช้งานใหม่',
      none: 'ยังไม่มีแพ็กเกจ เลือกแพ็กเกจเพื่อเริ่มอัปโหลด',
      choosePlan: 'เลือกแพ็กเกจ',
      renew: 'ต่ออายุตอนนี้',
    },
    plans: {
      heading: 'เลือกแพ็กเกจ',
      current: 'แพ็กเกจปัจจุบัน',
      select: 'เลือก {plan}',
      pendingBlocked: 'มีการลดแพ็กเกจที่รอมีผลอยู่ จึงเปลี่ยนแพ็กเกจไม่ได้จนกว่าจะถึงวันที่มีผล',
      loadError: 'โหลดรายการแพ็กเกจไม่สำเร็จ',
    },
    checkout: {
      heading: '{change} แพ็กเกจ {plan}',
      changeTypes,
      explain: changeExplanations,
      method: 'วิธีชำระเงิน',
      promptpay: 'พร้อมเพย์ (ชำระล่วงหน้า)',
      promptpayHint: 'สแกน QR ด้วยแอปธนาคาร ไม่ต่ออายุอัตโนมัติ',
      card: 'บัตรเครดิต/เดบิต (ต่ออายุอัตโนมัติ)',
      cardHint:
        'กรอกข้อมูลบัตรในหน้าของผู้ให้บริการชำระเงินที่ปลอดภัย เราไม่เห็นและไม่เก็บเลขบัตรของคุณ',
      cardUnavailableRenew:
        'แพ็กเกจนี้ต่ออายุอัตโนมัติด้วยบัตรอยู่แล้ว ต่ออายุล่วงหน้าได้ด้วยพร้อมเพย์',
      cardUnavailableDowngrade:
        'ลดแพ็กเกจด้วยบัตรได้เฉพาะเมื่อเปิดต่ออายุอัตโนมัติอยู่ กรุณาชำระด้วยพร้อมเพย์',
      cardDowngradeNote: 'ไม่มีการตัดเงินตอนนี้ การต่ออายุครั้งถัดไปจะตัดบัตรตามราคาแพ็กเกจใหม่',
      months: 'จำนวนเดือน',
      monthsOption: '{months, plural, =12 {12 เดือน (1 ปี)} other {# เดือน}} · {price}',
      interval: 'ต่ออายุทุก',
      intervalOption: '{months, plural, =1 {ทุกเดือน} =12 {ทุกปี} other {ทุก # เดือน}} · {price}',
      upgradeAmount: 'ยอดที่ต้องชำระคือส่วนต่างตามจำนวนวันที่เหลือ ระบบจะแสดงยอดก่อนชำระ',
      pricesIncludeVat: 'ราคารวมภาษีมูลค่าเพิ่มแล้ว',
      pay: 'ไปชำระเงิน',
      submitting: 'กำลังสร้างรายการชำระเงิน…',
      back: 'เลือกแพ็กเกจอื่น',
    },
    payment: {
      amount: 'ยอดชำระ {amount}',
      vat: 'รวมภาษีมูลค่าเพิ่ม {vat}',
      proration: 'ส่วนต่าง {days, number} วันที่เหลือในรอบนี้',
      qrHeading: 'สแกน QR เพื่อชำระด้วยพร้อมเพย์',
      qrAlt: 'QR พร้อมเพย์ ยอด {amount}',
      qrExpires: 'QR นี้ใช้ได้ถึง {time}',
      qrHint: 'บนมือถือ: บันทึกภาพหน้าจอ แล้วเปิดภาพนี้ในแอปธนาคารเพื่อสแกน',
      waiting: 'กำลังรอการชำระเงิน หน้านี้จะอัปเดตเองเมื่อได้รับเงิน',
      redirecting: 'กำลังไปยังหน้าชำระเงินด้วยบัตร…',
      status: paymentStatus,
      paid: 'ชำระเงินสำเร็จ แพ็กเกจของคุณอัปเดตแล้ว',
      expired: 'QR หมดเวลาแล้วและยังไม่มีการตัดเงิน กรุณาเริ่มชำระเงินใหม่',
      failed: 'ชำระเงินไม่สำเร็จ กรุณาลองใหม่',
      refunded: 'รายการนี้คืนเงินแล้ว',
      unapplied:
        'ได้รับเงินแล้ว แต่ปรับแพ็กเกจไม่ได้เพราะสถานะบัญชีเปลี่ยนไประหว่างชำระ ทีมงานจะคืนเงินให้',
      completedFree: 'อัปเกรดเรียบร้อย ส่วนต่างน้อยกว่ายอดขั้นต่ำจึงไม่มีค่าใช้จ่าย',
      downgradeScheduled: 'ตั้งเวลาลดแพ็กเกจแล้ว มีผลตั้งแต่ {date}',
      completed: 'เปลี่ยนแพ็กเกจเรียบร้อย',
      startOver: 'เริ่มชำระเงินใหม่',
      done: 'กลับไปหน้าแพ็กเกจ',
      resume: 'ไปที่รายการที่รอชำระ',
    },
    return: {
      title: 'ผลการชำระเงินด้วยบัตร',
      checking: 'กำลังตรวจสอบผลการชำระเงิน…',
      missing: 'ไม่พบรายการชำระเงินนี้',
    },
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
  localLogin: {
    title: 'เข้าสู่ระบบ (โหมดทดสอบในเครื่อง)',
    subtitle: 'ใส่อีเมลอะไรก็ได้ อีเมลเดียวกันคือบัญชีเดียวกัน',
    notice:
      'หน้านี้มีเฉพาะตอนรันในเครื่อง (AUTH_PROVIDER=local) ระบบจริงใช้การเข้าสู่ระบบด้วย LINE, Google หรืออีเมล',
    email: 'อีเมล',
    name: 'ชื่อที่แสดง',
    defaultName: 'ช่างภาพทดสอบ',
    submit: 'เข้าสู่ระบบ',
  },
  studio: {
    drive: 'ไดรฟ์ของฉัน',
    trash: 'ถังขยะ',
    shares: 'ลิงก์แชร์',
    billing: 'แพ็กเกจ',
    logout: 'ออกจากระบบ',
    navLabel: 'เมนูสตูดิโอ',
    loadError: 'โหลดข้อมูลบัญชีไม่สำเร็จ',
  },
  onboarding: {
    title: 'ยินดีต้อนรับสู่ ShotX',
    body: 'เริ่มใช้งานในฐานะช่างภาพ ทดลองใช้ฟรี ไม่ต้องผูกบัตร',
    points: {
      upload: 'อัปโหลดรูปและวิดีโอจากงาน จัดเป็นโฟลเดอร์',
      share: 'แชร์ลิงก์ให้ผู้ร่วมงานเปิดดูและดาวน์โหลดรูป',
      stats: 'ดูสถิติผู้เข้าชมและการดาวน์โหลดของแต่ละลิงก์',
    },
    nameLabel: 'ชื่อที่แสดงบนหน้าแชร์ (ไม่บังคับ)',
    namePlaceholder: 'เช่น สมชาย ถ่ายภาพ',
    start: 'เริ่มทดลองใช้ฟรี',
    starting: 'กำลังเตรียมบัญชี…',
  },
  faceIndex: {
    title: 'ค้นหาด้วยใบหน้า: {name}',
    description:
      'เมื่อเปิด ระบบจะจัดทำดัชนีใบหน้าในรูปของโฟลเดอร์นี้และโฟลเดอร์ย่อย เพื่อให้ผู้ร่วมงานสแกนใบหน้าหารูปของตัวเองได้ ดัชนีจะหมดอายุและถูกลบอัตโนมัติ',
    statusOn: 'เปิดอยู่ ถึง {date}',
    statusOff: 'ปิดอยู่',
    informed:
      'ฉันยืนยันว่าได้แจ้งผู้ร่วมงานแล้วว่ารูปในโฟลเดอร์นี้จะใช้ค้นหาด้วยใบหน้า (เช่น ประกาศของผู้จัดงาน หรือความยินยอมตอนลงทะเบียน)',
    informedRequired: 'กรุณายืนยันว่าได้แจ้งผู้ร่วมงานแล้ว',
    enable: 'เปิดการค้นหาด้วยใบหน้า',
    extend: 'ขยายเวลา',
    disable: 'ปิดการค้นหาด้วยใบหน้า',
    enabled: 'เปิดการค้นหาด้วยใบหน้าแล้ว ระบบกำลังจัดทำดัชนีใบหน้า',
    disabled: 'ปิดการค้นหาด้วยใบหน้าแล้ว ใบหน้าที่จัดทำดัชนีไว้จะถูกลบ',
    badge: 'ค้นหาด้วยใบหน้า',
  },
  shareDialog: {
    title: 'แชร์ “{name}”',
    existing: 'ลิงก์ที่มีอยู่',
    none: 'ยังไม่มีลิงก์สำหรับรายการนี้',
    newLink: 'สร้างลิงก์ใหม่',
    created: 'สร้างลิงก์แล้ว คัดลอกไปแชร์ได้เลย',
  },
  shareForm: {
    mode: 'รูปแบบการแชร์',
    modes: shareModes,
    faceOnlyFolderOnly: 'โหมดเฉพาะรูปของตัวเองใช้ได้กับการแชร์โฟลเดอร์เท่านั้น',
    allowDownload: 'อนุญาตให้ดาวน์โหลด',
    downloadSize: 'ขนาดไฟล์ที่ดาวน์โหลด',
    downloadSizes,
    requireLogin: 'ต้องเข้าสู่ระบบด้วย LINE หรือ Google ก่อนดู',
    requireLoginHint: 'นับจำนวนผู้เข้าชมได้แม่นยำขึ้น',
    usePassword: 'ตั้งรหัสผ่าน',
    password: 'รหัสผ่าน',
    passwordHint: 'อย่างน้อย {min, number} ตัวอักษร ห้ามขึ้นต้นหรือลงท้ายด้วยช่องว่าง',
    passwordInvalid:
      'รหัสผ่านต้องยาว {min, number}–{max, number} ตัวอักษร และไม่ขึ้นต้นหรือลงท้ายด้วยช่องว่าง',
    keepPassword: 'เว้นว่างไว้เพื่อใช้รหัสผ่านเดิม',
    useExpiry: 'กำหนดวันหมดอายุ',
    expiry: 'ใช้ได้ถึงวันที่ (สิ้นวัน เวลาไทย)',
    expiryInvalid: 'วันหมดอายุต้องเป็นวันในอนาคต',
    create: 'สร้างลิงก์',
    save: 'บันทึกการตั้งค่า',
    saved: 'บันทึกการตั้งค่าแล้ว',
  },
  shares: {
    title: 'ลิงก์แชร์ทั้งหมด',
    empty: 'ยังไม่มีลิงก์แชร์ เปิดเมนูของไฟล์หรือโฟลเดอร์แล้วเลือก “แชร์”',
    listLabel: 'รายการลิงก์แชร์',
    copy: 'คัดลอกลิงก์',
    copied: 'คัดลอกลิงก์แล้ว',
    revoke: 'ยกเลิกลิงก์',
    revokeTitle: 'ยกเลิกลิงก์นี้?',
    revokeBody: 'ทุกคนที่มีลิงก์จะเปิดไม่ได้อีก และเปิดใช้ลิงก์นี้ใหม่ไม่ได้ ต้องสร้างลิงก์ใหม่แทน',
    revoked: 'ยกเลิกลิงก์แล้ว',
    stats: 'สถิติและการตั้งค่า',
    status: shareStatus,
    folder: 'โฟลเดอร์',
    file: 'ไฟล์',
    passwordProtected: 'มีรหัสผ่าน',
    requireLogin: 'ต้องเข้าสู่ระบบ',
    noDownload: 'ห้ามดาวน์โหลด',
    faceOnly: 'เฉพาะรูปของตัวเอง',
    expiresAt: 'หมดอายุ {date}',
    targetUnavailable: 'ไฟล์หรือโฟลเดอร์ถูกลบ ลิงก์นี้จึงเปิดไม่ได้',
    loadingMore: 'กำลังโหลดเพิ่ม…',
    loadMore: 'โหลดเพิ่ม',
  },
  shareStats: {
    back: 'กลับไปที่ลิงก์แชร์ทั้งหมด',
    title: 'สถิติของลิงก์ “{name}”',
    from: 'ตั้งแต่',
    to: 'ถึง',
    apply: 'แสดง',
    totals: 'รวมทั้งช่วง',
    visitors: 'ผู้เข้าชม',
    scanners: 'ผู้สแกนใบหน้า',
    scans: 'จำนวนสแกน',
    downloads: 'ดาวน์โหลดรายรูป',
    uniqueDownloaders: 'ผู้ดาวน์โหลด',
    zips: 'ดาวน์โหลดแบบ zip',
    bytesOut: 'ข้อมูลที่ส่งออก',
    date: 'วันที่',
    empty: 'ยังไม่มีกิจกรรมในช่วงนี้',
    rolledUpAt: 'อัปเดตล่าสุด {time} (สรุปทุกชั่วโมง)',
    settings: 'ตั้งค่าลิงก์',
    revokedNote: 'ลิงก์นี้ถูกยกเลิกแล้ว แก้ไขการตั้งค่าไม่ได้',
  },
  share: {
    byPhotographer: 'ถ่ายโดย {name}',
    itemCount: '{count, number} รูป',
    expiresAt: 'ลิงก์ใช้ได้ถึง {date}',
    galleryLabel: 'รูปในลิงก์นี้',
    empty: 'ยังไม่มีรูปในลิงก์นี้',
    loadingMore: 'กำลังโหลดเพิ่ม…',
    loadError: 'โหลดรูปไม่สำเร็จ',
    open: 'เปิดดู {name}',
    select: 'เลือก {name}',
    video: 'วิดีโอ',
    yourPhotos: 'รูปของคุณ',
    allPhotos: 'รูปทั้งหมด',
    unavailable: {
      title: 'ลิงก์นี้หมดอายุ',
      body: 'ติดต่อช่างภาพหากต้องการลิงก์ใหม่',
      reasons: shareUnavailableReasons,
      deleteHint: 'หากคุณอยู่ในรูปของลิงก์นี้ ยังขอลบใบหน้าของคุณออกจากระบบค้นหาของช่างภาพได้',
    },
    login: {
      title: 'เข้าสู่ระบบเพื่อดูรูป',
      body: 'ช่างภาพตั้งให้ลิงก์นี้ต้องเข้าสู่ระบบก่อนเปิดดู',
      line: 'เข้าสู่ระบบด้วย LINE',
      google: 'เข้าสู่ระบบด้วย Google',
      connecting: 'กำลังเชื่อมต่อบัญชีของคุณ…',
    },
    password: {
      title: 'ลิงก์นี้มีรหัสผ่าน',
      body: 'ใส่รหัสผ่านที่ได้รับจากช่างภาพหรือผู้จัดงาน',
      label: 'รหัสผ่าน',
      submit: 'เปิดดูรูป',
    },
    faceOnly: {
      title: 'ค้นหารูปของคุณ',
      body: 'ลิงก์นี้แสดงเฉพาะรูปที่มีคุณอยู่ สแกนใบหน้าเพื่อดูรูปของคุณ',
      unavailable: 'ลิงก์นี้ยังสแกนใบหน้าไม่ได้ในขณะนี้ กรุณาลองใหม่ภายหลัง',
    },
    scan: 'ค้นหารูปของฉันด้วยใบหน้า',
    scanAgain: 'สแกนใหม่',
    deleteMyFace: 'ขอลบใบหน้าของฉัน',
    withdraw: 'ถอนความยินยอมใช้ข้อมูลใบหน้า',
    withdrawn: 'ถอนความยินยอมแล้ว และลบผลการค้นหาของคุณแล้ว',
  },
  consent: {
    version: 'ฉบับวันที่ {version}',
    accept: 'ยอมรับและเริ่มสแกน',
    acceptDeletion: 'ยอมรับและถ่ายเซลฟี',
    decline: 'ไม่ยอมรับ',
    mustCheck: 'กรุณาติ๊กยอมรับก่อนเริ่มสแกน',
    policies: consentPolicies,
  },
  capture: {
    title: 'ถ่ายเซลฟี',
    guidance: 'หันหน้าตรง ถอดแว่นดำ/แมสก์ อยู่ในที่สว่าง',
    notStored: 'รูปเซลฟีใช้ค้นหาครั้งนี้เท่านั้น ไม่ถูกบันทึกไว้ในเครื่องหรือในระบบ',
    openCamera: 'เปิดกล้อง',
    takePhoto: 'ถ่ายรูป',
    useCameraApp: 'ถ่ายรูปด้วยกล้อง',
    chooseFromGallery: 'เลือกรูปจากคลังภาพ',
    cameraBlocked: 'เปิดกล้องในหน้านี้ไม่ได้ กดปุ่มด้านล่างเพื่อถ่ายรูปด้วยกล้องของเครื่องแทน',
    inAppHint:
      'หากเปิดจาก LINE หรือ Facebook แล้วถ่ายรูปไม่ได้ ลองเปิดลิงก์นี้ในเบราว์เซอร์ (Safari หรือ Chrome)',
    preview: 'ภาพจากกล้องหน้า',
    checking: 'กำลังตรวจรูป…',
    retake: 'ถ่ายใหม่',
    issues: selfieIssues,
    angles: selfieAngles,
    angleStep: 'มุมที่ {current, number} จาก {max, number}: {angle}',
    addAngle: 'เพิ่มอีกมุม ({angle})',
    addAngleHint: 'เพิ่มมุมด้านข้างช่วยให้เจอรูปที่ถ่ายจากด้านข้างหรือระยะไกลได้มากขึ้น',
    selfieAlt: 'เซลฟีมุมที่ {n, number}',
    remove: 'ลบรูปนี้',
    search: 'ค้นหารูปของฉัน',
    searching: 'กำลังค้นหารูปของคุณ…',
  },
  results: {
    strong: 'ใช่คุณ',
    maybe: 'อาจจะเป็นคุณ',
    groupCount: '{count, number} รูป',
    notMe: 'ไม่ใช่ฉัน',
    notMeLabel: 'ไม่ใช่ฉัน: {name}',
    notMeDone: 'ซ่อนรูปนี้แล้ว ขอบคุณที่ช่วยให้การค้นหาแม่นยำขึ้น',
    none: 'ไม่พบรูปที่ตรงกับใบหน้าของคุณ',
    noneHint: 'ลองถ่ายใหม่ในที่สว่าง หันหน้าตรง หรือเพิ่มมุมด้านข้าง',
    partialNoFace: 'ไม่พบใบหน้าใน {count, number} รูปที่ส่ง จึงค้นหาจากรูปที่เหลือ',
  },
  faceDeletion: {
    title: 'ขอลบใบหน้าของฉัน',
    intro:
      'ถ่ายเซลฟีเพื่อค้นหาและลบใบหน้าของคุณออกจากระบบค้นหาของช่างภาพรายนี้ รูปถ่ายจะยังอยู่ แต่จะไม่มีใครค้นหาคุณด้วยใบหน้าในรูปของช่างภาพรายนี้ได้อีก',
    submit: 'ค้นหาและลบใบหน้าของฉัน',
    submitting: 'กำลังค้นหาใบหน้าของคุณ…',
    done: '{count, plural, =0 {ไม่พบใบหน้าของคุณในรูปของช่างภาพรายนี้} other {พบใบหน้าของคุณ # ใบหน้า และกำลังลบออกจากระบบค้นหา}}',
    doneNote: 'ใบหน้าที่พบถูกซ่อนจากการค้นหาทันที และจะถูกลบถาวรภายในไม่กี่นาที',
    close: 'กลับไปที่ลิงก์',
    loadError: 'เปิดหน้าขอลบใบหน้าไม่ได้',
  },
  downloads: {
    download: 'ดาวน์โหลด',
    downloadOne: 'ดาวน์โหลด {name}',
    downloadSelected: 'ดาวน์โหลด {count, number} รูป',
    selected: 'เลือกแล้ว {count, number} รูป',
    clear: 'ยกเลิกการเลือก',
    selectAll: 'เลือกทั้งหมดที่แสดง',
    size: 'ไฟล์{size}',
    sizes: downloadSizes,
    saveToPhotos: 'บันทึกลงแอปรูปภาพ',
    preparing: 'กำลังเตรียมรูป {done, number}/{total, number}…',
    readyToSave: 'พร้อมแล้ว แตะเพื่อบันทึก {count, number} รูป',
    tooManyToSave: 'บันทึกลงแอปรูปภาพได้ครั้งละไม่เกิน {max, number} รูป ใช้ดาวน์โหลดแบบ zip แทน',
    zipStatus,
  },
  lightbox: {
    close: 'ปิด',
    next: 'รูปถัดไป',
    prev: 'รูปก่อนหน้า',
    zoom: 'ซูม',
    download: 'ดาวน์โหลดรูปนี้',
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
    share: 'แชร์',
    faceIndex: 'ค้นหาด้วยใบหน้า',
    download: 'ดาวน์โหลดต้นฉบับ',
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
    manage: 'จัดการแพ็กเกจ',
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
      shareRevoked: 'ลิงก์นี้หมดอายุ ช่างภาพยกเลิกลิงก์นี้แล้ว',
      shareExpired: 'ลิงก์นี้หมดอายุ',
      shareUnavailable: 'ลิงก์นี้หมดอายุ รูปในลิงก์นี้ไม่เปิดให้ดูแล้ว',
      zipTooLarge:
        'ดาวน์โหลดพร้อมกันได้ไม่เกิน {maxFiles, number} รูป และรวมไม่เกิน {maxBytes} (เลือกไว้ {files, number} รูป {bytes})',
      noFaceDetected:
        'ไม่พบใบหน้าในรูปที่ส่ง ({count, number} รูป) กรุณาหันหน้าตรง ถอดแว่นดำ/แมสก์ และอยู่ในที่สว่าง',
      faceSearchNotFolder: 'ค้นหาด้วยใบหน้าได้เฉพาะลิงก์ที่แชร์ทั้งโฟลเดอร์',
      faceSearchNotIndexed: 'ช่างภาพยังไม่เปิดการค้นหาด้วยใบหน้าสำหรับรูปในลิงก์นี้',
      checkoutPending:
        'มีรายการชำระเงินที่ยังรอชำระอยู่ (หมดเวลา {time}) กรุณาชำระรายการนั้นให้เสร็จ หรือรอให้หมดเวลาก่อน',
    },
    planChange: planChangeReasons,
    notices: billingNotices,
    client: {
      network: 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง',
      contract: 'ระบบตอบกลับไม่ถูกต้อง กรุณาลองใหม่',
      unknown: 'เกิดข้อผิดพลาด กรุณาลองใหม่',
      emptyFile: 'ไฟล์นี้ว่างเปล่า',
      invalidRelativePath: 'ชื่อโฟลเดอร์ในเส้นทาง “{path}” ใช้ไม่ได้',
      uploadPlanMismatch: 'การตั้งค่าการอัปโหลดไม่ตรงกับเซิร์ฟเวอร์ กรุณารีเฟรชหน้าแล้วลองใหม่',
      storageUpload: 'ส่งไฟล์ไปยังที่จัดเก็บไม่สำเร็จ กรุณาลองใหม่',
      zipFailed: 'เตรียมไฟล์ zip ไม่สำเร็จ กรุณาลองใหม่',
      zipExpired: 'ไฟล์ zip หมดอายุแล้ว กรุณากดดาวน์โหลดใหม่',
      zipTimeout: 'เตรียมไฟล์ zip นานเกินไป กรุณาลองใหม่ หรือเลือกรูปให้น้อยลง',
      saveFailed: 'บันทึกรูปไม่สำเร็จ กรุณาลองใหม่',
      copyFailed: 'คัดลอกไม่สำเร็จ กรุณากดค้างที่ลิงก์เพื่อคัดลอกเอง',
      consentVersionUnknown:
        'ข้อความขอความยินยอมมีฉบับใหม่ กรุณารีเฟรชหน้านี้เพื่ออ่านฉบับล่าสุดก่อนยอมรับ',
    },
  },
} as const;

export type Messages = typeof th;
