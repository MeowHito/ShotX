import type { AccountRole, AccountStatus, ErrorCode, PasswordPolicyReason } from '@shotx/shared';

/**
 * Thai copy of the admin app, the default locale and the source of the key tree: messages/en.ts
 * and messages/zh.ts translate every key (messages/translation.ts, locales.test.ts). Every API
 * ErrorCode has a message (`errors.codes` is an exhaustive Record), so an unknown code can't reach
 * the screen untranslated.
 */

const errorCodes = {
  QUOTA_EXCEEDED: 'พื้นที่จัดเก็บไม่พอ',
  SHARE_EXPIRED: 'ลิงก์นี้หมดอายุ',
  CONSENT_REQUIRED: 'ต้องได้รับความยินยอมก่อน',
  NO_FACE_DETECTED: 'ไม่พบใบหน้าในรูป',
  RATE_LIMITED: 'ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',
  PAYLOAD_TOO_LARGE: 'ข้อมูลที่ส่งมีขนาดใหญ่เกินไป',
  UNSUPPORTED_FILE_TYPE: 'ไม่รองรับไฟล์ประเภทนี้',
  FILE_TOO_LARGE: 'ไฟล์มีขนาดใหญ่เกินกำหนด',
  VALIDATION_FAILED: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่',
  UNAUTHENTICATED: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง',
  FORBIDDEN: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
  NOT_FOUND: 'ไม่พบรายการนี้ อาจถูกลบหรือเปลี่ยนไปแล้ว',
  CONFLICT:
    'ทำรายการนี้กับบัญชีนี้ไม่ได้ (เช่น บัญชีที่เข้าสู่ระบบด้วย LINE หรือ Google ไม่มีรหัสผ่านให้รีเซ็ต)',
  INTERNAL_ERROR: 'ระบบขัดข้อง กรุณาลองใหม่ภายหลัง',
  NAME_TAKEN: 'มีชื่อนี้อยู่แล้ว',
  INVALID_MOVE: 'ย้ายรายการนี้ไม่ได้',
  FOLDER_DEPTH_EXCEEDED: 'โฟลเดอร์ซ้อนกันลึกเกินกำหนด',
  SUBSCRIPTION_INACTIVE: 'แพ็กเกจไม่ได้ใช้งานอยู่',
  UPLOAD_NOT_FOUND: 'ไม่พบการอัปโหลดนี้',
  UPLOAD_EXPIRED: 'การอัปโหลดหมดเวลา',
  UPLOAD_PARTS_INVALID: 'ไฟล์ที่อัปโหลดไม่ครบหรือเสียหาย',
  IDEMPOTENCY_KEY_REUSED:
    'รายการนี้ถูกส่งไปแล้วด้วยข้อมูลที่ต่างกัน กรุณาตรวจสอบรายการรับเงินล่าสุดก่อนบันทึกใหม่',
  LOGIN_REQUIRED: 'ต้องเข้าสู่ระบบก่อน',
  PASSWORD_REQUIRED: 'ต้องใส่รหัสผ่านก่อน',
  PASSWORD_INCORRECT: 'รหัสผ่านไม่ถูกต้อง',
  CONSENT_VERSION_MISMATCH: 'ข้อความขอความยินยอมมีการปรับปรุง',
  DOWNLOAD_NOT_ALLOWED: 'ไม่อนุญาตให้ดาวน์โหลด',
  ZIP_TOO_LARGE: 'เลือกไฟล์มากเกินไป',
  FEATURE_DISABLED: 'ฟีเจอร์นี้ยังไม่เปิดให้ใช้งาน',
  FACE_SEARCH_UNAVAILABLE: 'ค้นหาด้วยใบหน้าไม่ได้',
  PLAN_NOT_FOUND: 'ไม่พบแพ็กเกจนี้',
  PLAN_CHANGE_INVALID: 'เปลี่ยนแพ็กเกจแบบนี้ไม่ได้',
  CHECKOUT_PENDING: 'มีรายการชำระเงินที่ยังรอชำระอยู่',
  CHECKOUT_EXPIRED: 'รายการชำระเงินหมดเวลาแล้ว',
  WEBHOOK_SIGNATURE_INVALID: 'ยืนยันข้อมูลการชำระเงินไม่ได้',
  PAYMENT_GATEWAY_ERROR: 'ระบบชำระเงินขัดข้องชั่วคราว',
  AUTH_PROVIDER_UNAVAILABLE: 'ยังเข้าสู่ระบบด้วยช่องทางนี้ไม่ได้',
  LOGIN_STATE_INVALID: 'การเข้าสู่ระบบหมดเวลาหรือถูกใช้ไปแล้ว กรุณาเริ่มเข้าสู่ระบบใหม่อีกครั้ง',
  IDENTITY_PROVIDER_ERROR: 'เชื่อมต่อผู้ให้บริการเข้าสู่ระบบไม่สำเร็จ',
  INVALID_CREDENTIALS: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  MFA_INVALID: 'รหัสยืนยันตัวตนไม่ถูกต้องหรือหมดเวลาแล้ว กรุณาใส่รหัสล่าสุดจากแอปยืนยันตัวตน',
  MFA_REQUIRED: 'ต้องยืนยันตัวตนด้วยรหัสจากแอปยืนยันตัวตนก่อน กรุณาเข้าสู่ระบบอีกครั้ง',
  REFRESH_TOKEN_INVALID: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง',
  REFRESH_TOKEN_REUSED:
    'ระบบออกจากระบบให้เพื่อความปลอดภัย เพราะพบการใช้เซสชันเดิมซ้ำ กรุณาเข้าสู่ระบบอีกครั้ง',
  PASSWORD_CHANGE_REQUIRED: 'ต้องเปลี่ยนรหัสผ่านชั่วคราวก่อนใช้งาน',
  ACCOUNT_DISABLED: 'บัญชีนี้ถูกปิดใช้งาน ติดต่อแอดมินคนอื่นหากต้องการเปิดใช้งานอีกครั้ง',
  EMAIL_TAKEN:
    'อีเมลนี้มีบัญชีอยู่แล้ว (แอดมินหรือตากล้อง) ใช้อีเมลอื่น หรือค้นหาบัญชีเดิมในรายชื่อ',
  LAST_ADMIN:
    'ปิดใช้งานแอดมินคนสุดท้ายที่ยังใช้งานอยู่ไม่ได้ ต้องมีแอดมินที่ใช้งานได้อย่างน้อย 1 คน',
  CANNOT_MODIFY_SELF:
    'ปิดใช้งานหรือรีเซ็ตรหัสผ่านบัญชีของตัวเองไม่ได้ ให้แอดมินคนอื่นทำให้ (เปลี่ยนชื่อตัวเองได้)',
  PASSWORD_TOO_WEAK: 'รหัสผ่านไม่ผ่านเกณฑ์ความปลอดภัย กรุณาตั้งรหัสผ่านใหม่',
  COVER_FILE_INVALID:
    'ใช้ไฟล์นี้เป็นรูปปกไม่ได้ ต้องเป็นรูปภาพที่พร้อมใช้งานและอยู่ในโฟลเดอร์นี้หรือโฟลเดอร์ย่อย',
  LOGIN_PROVIDER_UNAVAILABLE:
    'ยังเปิดให้ผู้ชมเข้าสู่ระบบไม่ได้ (ยังไม่ได้ตั้งค่า LINE หรือ Google) จึงตั้งลิงก์ให้ต้องเข้าสู่ระบบก่อนดูไม่ได้',
} as const satisfies Record<ErrorCode, string>;

/** PASSWORD_TOO_WEAK details.reason, with the pool's minimum length. */
const passwordPolicy = {
  too_short: 'รหัสผ่านสั้นเกินไป ต้องยาวอย่างน้อย {minLength, number} ตัวอักษร',
  too_simple:
    'รหัสผ่านเดาง่ายเกินไป (ตัวอักษรซ้ำกันมากหรือเรียงกัน) ใช้ตัวอักษรที่หลากหลาย อย่างน้อย {minLength, number} ตัวอักษร',
  contains_email:
    'รหัสผ่านต้องไม่มีอีเมลของบัญชีอยู่ในนั้น ตั้งรหัสอื่นที่ยาวอย่างน้อย {minLength, number} ตัวอักษร',
  common:
    'รหัสผ่านนี้มีคนใช้กันมากและเดาง่าย ตั้งรหัสอื่นที่ยาวอย่างน้อย {minLength, number} ตัวอักษร',
  same_as_current:
    'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม ตั้งรหัสอื่นที่ยาวอย่างน้อย {minLength, number} ตัวอักษร',
} as const satisfies Record<PasswordPolicyReason, string>;

const roles = { admin: 'แอดมิน', photographer: 'ตากล้อง' } as const satisfies Record<
  AccountRole,
  string
>;

const statuses = { active: 'ใช้งานอยู่', disabled: 'ปิดใช้งาน' } as const satisfies Record<
  AccountStatus,
  string
>;

export const th = {
  metadata: {
    title: 'Snap แอดมิน',
  },
  common: {
    appName: 'Snap',
    adminBadge: 'แอดมิน',
    close: 'ปิด',
    cancel: 'ยกเลิก',
    save: 'บันทึก',
    saving: 'กำลังบันทึก…',
    loading: 'กำลังโหลด…',
    retry: 'ลองอีกครั้ง',
    back: 'ย้อนกลับ',
    none: '–',
  },
  /** The language switcher (sign-in page and admin frame). Each language in its own script. */
  language: {
    label: 'ภาษา',
    locales: { th: 'ไทย', en: 'English', zh: '中文' },
  },
  login: {
    eyebrow: 'สำหรับแอดมินเท่านั้น',
    title: 'เข้าสู่ระบบแอดมิน',
    subtitle: 'ใช้อีเมลและรหัสผ่านของบัญชีแอดมิน',
    subtitleTotp: 'ใช้อีเมล รหัสผ่าน และรหัสจากแอปยืนยันตัวตน (เช่น Google Authenticator)',
    email: 'อีเมล',
    password: 'รหัสผ่าน',
    submit: 'ถัดไป',
    submitting: 'กำลังตรวจสอบ…',
    startOver: 'เริ่มใหม่',
    notices: {
      expired: 'ขั้นตอนเข้าสู่ระบบหมดเวลาแล้ว กรุณาใส่อีเมลและรหัสผ่านอีกครั้ง',
      unexpected: 'ขั้นตอนเข้าสู่ระบบไม่ต่อเนื่อง กรุณาเริ่มใหม่อีกครั้ง',
      session: 'กรุณาเข้าสู่ระบบอีกครั้ง',
    },
    changePassword: {
      title: 'ตั้งรหัสผ่านใหม่',
      description:
        'รหัสผ่านนี้เป็นรหัสชั่วคราวที่แอดมินตั้งให้ ต้องตั้งรหัสผ่านใหม่ของคุณเองก่อนใช้งาน',
      newPassword: 'รหัสผ่านใหม่',
      confirmPassword: 'ยืนยันรหัสผ่านใหม่',
      mismatch: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน',
      submit: 'ตั้งรหัสผ่านใหม่',
    },
    enrol: {
      title: 'ตั้งค่าแอปยืนยันตัวตน',
      description:
        'สแกน QR นี้ด้วยแอปยืนยันตัวตนในโทรศัพท์ของคุณ แล้วใส่รหัส 6 หลักที่แอปแสดงเพื่อยืนยัน',
      once: 'QR และรหัสลับนี้แสดงครั้งเดียวเท่านั้น ห้ามแคปหน้าจอหรือส่งต่อให้ผู้อื่น',
      qrLabel: 'QR สำหรับเพิ่มบัญชีในแอปยืนยันตัวตน',
      manual: 'สแกนไม่ได้? ใส่รหัสลับนี้ในแอปเอง',
      secret: 'รหัสลับ',
      account: 'บัญชี',
      issuer: 'ผู้ให้บริการ',
      timeBased: 'แบบตามเวลา {digits, number} หลัก ทุก {period, number} วินาที',
      invalidUri: 'อ่านข้อมูลสำหรับตั้งค่าไม่ได้ กรุณาเริ่มเข้าสู่ระบบใหม่',
    },
    totp: {
      title: 'ยืนยันตัวตน',
      description: 'ใส่รหัส 6 หลักจากแอปยืนยันตัวตนของคุณ',
      code: 'รหัสยืนยันตัวตน',
      submit: 'ยืนยันและเข้าสู่ระบบ',
      invalid: 'รหัสต้องเป็นตัวเลข 6 หรือ 8 หลัก',
    },
  },
  shell: {
    navLabel: 'เมนูแอดมิน',
    users: 'ผู้ใช้',
    logout: 'ออกจากระบบ',
    signedInAs: 'เข้าสู่ระบบเป็น {name}',
    openMenu: 'เปิดเมนู',
  },
  roles,
  statuses,
  users: {
    title: 'ผู้ใช้',
    description:
      'สร้างและจัดการบัญชีแอดมินและตากล้อง ตากล้องจ่ายเงินสดกับเจ้าของแล้วจึงสร้างบัญชีให้',
    create: 'สร้างผู้ใช้',
    search: 'ค้นหาด้วยอีเมลหรือชื่อ',
    searchSubmit: 'ค้นหา',
    filterRole: 'บทบาท',
    filterStatus: 'สถานะ',
    allRoles: 'ทุกบทบาท',
    allStatuses: 'ทุกสถานะ',
    clearFilters: 'ล้างตัวกรอง',
    tableLabel: 'รายชื่อผู้ใช้',
    columns: {
      email: 'อีเมล',
      name: 'ชื่อ',
      role: 'บทบาท',
      status: 'สถานะ',
      storage: 'พื้นที่ที่ใช้',
      lastSignIn: 'เข้าสู่ระบบล่าสุด',
      created: 'สร้างเมื่อ',
      actions: 'จัดการ',
    },
    never: 'ยังไม่เคย',
    noEmail: 'ไม่มีอีเมล (LINE/Google)',
    noName: 'ไม่มีชื่อ',
    you: 'คุณ',
    mustChange: 'รหัสชั่วคราว',
    totpPending: 'ยังไม่ได้ตั้งแอปยืนยันตัวตน',
    locked: 'ถูกล็อกชั่วคราว',
    loadMore: 'โหลดเพิ่ม',
    loadingMore: 'กำลังโหลด…',
    empty: 'ไม่พบผู้ใช้ที่ตรงกัน',
    loadError: 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ',
    actionsFor: 'จัดการบัญชี {name}',
    actions: {
      details: 'ดูรายละเอียดและการรับเงิน',
      rename: 'เปลี่ยนชื่อ',
      resetPassword: 'รีเซ็ตรหัสผ่าน',
      disable: 'ปิดใช้งาน',
      enable: 'เปิดใช้งาน',
    },
  },
  createUser: {
    title: 'สร้างผู้ใช้',
    description:
      'บัญชีใหม่จะใช้รหัสผ่านนี้เป็นรหัสชั่วคราว ผู้ใช้ต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบครั้งแรก',
    email: 'อีเมล',
    name: 'ชื่อที่แสดง',
    role: 'บทบาท',
    roleHints: {
      admin: 'จัดการผู้ใช้และดูข้อมูลทั้งระบบ',
      adminTotp: 'จัดการผู้ใช้และดูข้อมูลทั้งระบบ ต้องตั้งแอปยืนยันตัวตนเมื่อเข้าสู่ระบบครั้งแรก',
      photographer: 'อัปโหลดรูปและวิดีโอเข้าไดรฟ์ของตัวเอง และแชร์ลิงก์ให้ลูกค้า',
    },
    roleFixed: 'เปลี่ยนบทบาทภายหลังไม่ได้ ถ้าต้องการบทบาทอื่นให้สร้างบัญชีใหม่',
    submit: 'สร้างผู้ใช้',
    invalidEmail: 'กรุณาใส่อีเมลให้ถูกต้อง',
    invalidName: 'กรุณาใส่ชื่อ (ไม่เกิน 200 ตัวอักษร)',
  },
  passwordField: {
    label: 'รหัสผ่านชั่วคราว',
    generate: 'สุ่มรหัสผ่าน',
    hint: 'อย่างน้อย {minLength, number} ตัวอักษร กด “สุ่มรหัสผ่าน” เพื่อให้ได้รหัสที่ยาวและปลอดภัย',
    required: 'กรุณาใส่หรือสุ่มรหัสผ่าน',
  },
  oneTimePassword: {
    title: 'รหัสผ่านชั่วคราวของ {email}',
    note: 'คัดลอกรหัสนี้แล้วส่งให้เจ้าของบัญชีโดยตรง (เช่น บอกต่อหน้า) รหัสจะแสดงครั้งเดียว เมื่อปิดหน้าต่างนี้จะดูอีกไม่ได้ ต้องรีเซ็ตใหม่เท่านั้น',
    firstSignIn: 'เจ้าของบัญชีต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบครั้งแรก',
    label: 'รหัสผ่านชั่วคราว',
    copy: 'คัดลอกรหัสผ่าน',
    copied: 'คัดลอกแล้ว',
    copyFailed: 'คัดลอกไม่สำเร็จ กรุณาเลือกข้อความแล้วคัดลอกเอง',
    done: 'ส่งรหัสให้เจ้าของบัญชีแล้ว ปิดหน้าต่าง',
    created: 'สร้างบัญชี {email} แล้ว',
    reset: 'รีเซ็ตรหัสผ่านของ {email} แล้ว',
  },
  resetPassword: {
    title: 'รีเซ็ตรหัสผ่าน',
    description:
      'ตั้งรหัสผ่านชั่วคราวใหม่ให้ {email} ผู้ใช้จะออกจากระบบทุกอุปกรณ์ และต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบครั้งถัดไป',
    adminNote: 'แอปยืนยันตัวตนเดิมของแอดมินยังใช้ได้ ไม่ต้องตั้งใหม่',
    submit: 'รีเซ็ตรหัสผ่าน',
  },
  statusDialog: {
    disableTitle: 'ปิดใช้งานบัญชี {email}?',
    disableDescription:
      'ผู้ใช้จะออกจากระบบทุกอุปกรณ์ทันทีและเข้าสู่ระบบไม่ได้จนกว่าจะเปิดใช้งานอีกครั้ง',
    disablePhotographer:
      'ลิงก์แชร์ทั้งหมดของตากล้องคนนี้จะใช้ไม่ได้ระหว่างที่ปิดใช้งาน ไฟล์จะไม่ถูกลบ',
    disableConfirm: 'ปิดใช้งานบัญชี',
    enableTitle: 'เปิดใช้งานบัญชี {email}?',
    enableDescription:
      'ผู้ใช้จะเข้าสู่ระบบได้อีกครั้ง (ต้องเข้าสู่ระบบใหม่ เซสชันเดิมไม่กลับมา) และลิงก์แชร์ของตากล้องจะกลับมาใช้ได้',
    enableConfirm: 'เปิดใช้งานบัญชี',
    disabled: 'ปิดใช้งาน {email} แล้ว',
    enabled: 'เปิดใช้งาน {email} แล้ว',
  },
  renameDialog: {
    title: 'เปลี่ยนชื่อ',
    description: 'ชื่อที่แสดงของ {email}',
    name: 'ชื่อที่แสดง',
    submit: 'บันทึกชื่อ',
    renamed: 'เปลี่ยนชื่อแล้ว',
  },
  userDetail: {
    back: 'กลับไปหน้ารายชื่อผู้ใช้',
    loadError: 'โหลดข้อมูลผู้ใช้ไม่สำเร็จ',
    account: 'ข้อมูลบัญชี',
    signIn: 'การเข้าสู่ระบบ',
    passwordAccount: 'อีเมลและรหัสผ่าน',
    password: 'รหัสผ่าน',
    passwordTemporary: 'ยังเป็นรหัสชั่วคราว เจ้าของบัญชียังไม่ได้ตั้งรหัสผ่านของตัวเอง',
    adminFirstSignInPending: 'แอดมินคนนี้ต้องตั้งรหัสผ่านใหม่ในการเข้าสู่ระบบครั้งถัดไป',
    totp: 'แอปยืนยันตัวตน',
    totpEnrolled: 'ตั้งค่าแล้ว',
    totpPending:
      'ยังไม่ได้ตั้งค่า แอดมินคนนี้ยังเข้าสู่ระบบครั้งแรกไม่เสร็จ ถ้ายังค้างอยู่นาน ให้รีเซ็ตรหัสผ่านหรือปิดใช้งานบัญชีนี้ (ผู้สร้างบัญชีรู้รหัสชั่วคราว จึงอาจเข้าสู่ระบบก่อนเจ้าของบัญชีได้)',
    passwordOwn: 'เจ้าของบัญชีตั้งรหัสผ่านของตัวเองแล้ว',
    oidcAccount: 'LINE หรือ Google',
    lockedUntil: 'ถูกล็อกถึง {time}',
    disabledAt: 'ปิดใช้งานเมื่อ {time}',
    createdBy: 'สร้างโดยแอดมินในระบบ',
    createdByCli: 'สร้างจากคำสั่งของผู้ดูแลระบบ (หรือสร้างก่อนมีหน้านี้)',
  },
  cash: {
    title: 'การรับเงินสด',
    description: 'บันทึกไว้สำหรับทำบัญชีของเจ้าของเท่านั้น ไม่ได้เปิดหรือปิดบัญชีให้อัตโนมัติ',
    record: 'บันทึกรับเงินสด',
    amount: 'จำนวนเงิน (บาท)',
    amountPlaceholder: 'เช่น 1,500 หรือ 1500.50',
    paidAt: 'วันที่รับเงิน',
    note: 'หมายเหตุ (ไม่บังคับ)',
    noteHint: 'ไม่เกิน {max, number} ตัวอักษร',
    submit: 'บันทึกรับเงิน',
    confirmTitle: 'บันทึกรับเงินสด {amount}?',
    confirmDescription:
      'รับเงินจาก {name} วันที่ {date} รายการที่บันทึกแล้วแก้ไขหรือลบไม่ได้ในหน้านี้',
    confirm: 'ยืนยันบันทึก',
    recorded: 'บันทึกรับเงิน {amount} แล้ว',
    invalidAmount: 'กรุณาใส่จำนวนเงินเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง',
    amountNotPositive: 'จำนวนเงินต้องมากกว่า 0 บาท',
    amountTooLarge: 'จำนวนเงินต้องไม่เกิน {max} ต่อรายการ',
    invalidDate: 'กรุณาเลือกวันที่รับเงิน',
    futureDate: 'วันที่รับเงินต้องไม่เป็นวันในอนาคต',
    noteTooLong: 'หมายเหตุยาวเกิน {max, number} ตัวอักษร',
    tableLabel: 'รายการรับเงินสด',
    columns: {
      paidAt: 'วันที่รับเงิน',
      amount: 'จำนวนเงิน',
      note: 'หมายเหตุ',
      recordedAt: 'บันทึกเมื่อ',
    },
    empty: 'ยังไม่มีรายการรับเงินสด',
    loadError: 'โหลดรายการรับเงินไม่สำเร็จ',
    loadMore: 'โหลดเพิ่ม',
    total: 'รวมที่แสดงอยู่ {amount}',
    notPhotographer: 'บันทึกรับเงินสดได้เฉพาะบัญชีตากล้อง',
  },
  errors: {
    codes: errorCodes,
    passwordPolicy,
    rateLimitedWait: 'ลองหลายครั้งเกินไป กรุณารออีก {minutes, number} นาทีแล้วลองใหม่',
    client: {
      network: 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง',
      contract: 'ระบบตอบกลับไม่ถูกต้อง กรุณาลองใหม่',
      unknown: 'เกิดข้อผิดพลาด กรุณาลองใหม่',
    },
  },
} as const;

export type Messages = typeof th;
