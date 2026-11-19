import {
  PRINT_CUSTOMER_NAME_MAX_LENGTH,
  PRINT_DEVICE_LIMIT_MAX,
  PRINT_PAPER_SIZE_CODES,
} from '@shotx/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, id, timestamptz } from './columns';
import { files } from './drive';
import { printApproval, printOrderStatus } from './enums';
import { shares } from './sharing';

const sizeList = sql.raw(PRINT_PAPER_SIZE_CODES.map((c) => `'${c}'`).join(', '));
const sizeArray = sql.raw(
  `ARRAY[${PRINT_PAPER_SIZE_CODES.map((c) => `'${c}'`).join(', ')}]::text[]`,
);
const deviceLimitMax = sql.raw(String(PRINT_DEVICE_LIMIT_MAX));
const nameMax = sql.raw(String(PRINT_CUSTOMER_NAME_MAX_LENGTH));

/**
 * A photographer's print-order settings (ADR 0031), one row per photographer, written by
 * PUT /print/settings. No row: print orders off (PRINT_SETTINGS_DEFAULTS).
 */
export const printSettings = pgTable(
  'print_settings',
  {
    photographerId: uuid('photographer_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    approval: printApproval('approval').notNull().default('manual'),
    perDeviceLimit: integer('per_device_limit').notNull().default(1),
    /** Codes of PRINT_PAPER_SIZES on offer, in that table's order. */
    paperSizes: text('paper_sizes').array().notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'print_settings_per_device_limit_range',
      sql`${t.perDeviceLimit} BETWEEN 1 AND ${deviceLimitMax}`,
    ),
    check(
      'print_settings_paper_sizes_valid',
      sql`cardinality(${t.paperSizes}) >= 1 AND ${t.paperSizes} <@ ${sizeArray}`,
    ),
  ],
);

/**
 * One photo a share viewer asked the photographer to print (ADR 0031). The device is the
 * browser's anon_id cookie (always set, also for a signed-in viewer, whose id is kept too); the
 * per-device limit counts a device's orders on the share that are not `rejected`. Orders are
 * numbered per photographer (`order_number`, from 1), taken under a per-photographer advisory
 * lock together with the limit check. Purging the file or deleting the share removes its orders.
 */
export const printOrders = pgTable(
  'print_orders',
  {
    id: id(),
    photographerId: uuid('photographer_id')
      .notNull()
      .references(() => users.id),
    orderNumber: integer('order_number').notNull(),
    shareId: uuid('share_id').notNull(),
    fileId: uuid('file_id').notNull(),
    anonId: uuid('anon_id').notNull(),
    viewerId: uuid('viewer_id').references(() => users.id),
    paperSize: text('paper_size').notNull(),
    /** Optional, typed by the viewer (name, bib number) so the print can be handed over. */
    customerName: text('customer_name'),
    status: printOrderStatus('status').notNull(),
    createdAt: createdAt(),
    /** When the photographer allowed or rejected it. */
    decidedAt: timestamptz('decided_at'),
    /** Last time it was taken for printing. */
    printedAt: timestamptz('printed_at'),
    printCount: integer('print_count').notNull().default(0),
  },
  (t) => [
    unique('print_orders_number_unique').on(t.photographerId, t.orderNumber),
    foreignKey({
      name: 'print_orders_share_same_owner_fk',
      columns: [t.shareId, t.photographerId],
      foreignColumns: [shares.id, shares.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'print_orders_file_same_owner_fk',
      columns: [t.fileId, t.photographerId],
      foreignColumns: [files.id, files.ownerId],
    }).onDelete('cascade'),
    // The per-device limit and the share page's "my orders".
    index('print_orders_share_device_idx').on(t.shareId, t.anonId, t.createdAt),
    // The studio list by status, newest first.
    index('print_orders_photographer_status_idx').on(t.photographerId, t.status, t.createdAt),
    check('print_orders_paper_size_valid', sql`${t.paperSize} IN (${sizeList})`),
    check('print_orders_order_number_positive', sql`${t.orderNumber} > 0`),
    check('print_orders_print_count_nonnegative', sql`${t.printCount} >= 0`),
    check(
      'print_orders_customer_name_length',
      sql`${t.customerName} IS NULL OR char_length(${t.customerName}) BETWEEN 1 AND ${nameMax}`,
    ),
    check(
      'print_orders_printed_shape',
      sql`(${t.status} = 'printed') = (${t.printedAt} IS NOT NULL AND ${t.printCount} > 0)`,
    ),
  ],
);
