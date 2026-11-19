import { z } from 'zod';
import {
  PRINT_APPROVAL_MODES,
  PRINT_ORDER_STATUSES,
  PRINT_PAPER_SIZE_CODES,
  type PrintApprovalMode,
  type PrintPaperSize,
} from '../domain';
import { idSchema, isoDateTimeSchema, signedUrlSchema } from './common';

// Print orders (ADR 0031). A viewer of a share link asks the photographer to print one photo on
// a paper size the photographer offers; the order lands in the photographer's studio ("สั่งพิมพ์"),
// which prints it on the photographer's own printer (a browser tab acting as the print station).
// Nothing is printed by the viewer and nothing is paid online.

/** Most prints a photographer can allow per device and share (`print_settings.per_device_limit`). */
export const PRINT_DEVICE_LIMIT_MAX = 100;

/** Longest name a viewer may leave on an order, so the photographer knows whose print it is. */
export const PRINT_CUSTOMER_NAME_MAX_LENGTH = 60;

/** Most orders GET /print/orders answers (newest first). */
export const PRINT_ORDER_LIST_LIMIT = 200;

/** What a photographer without a `print_settings` row has: print orders off. */
export const PRINT_SETTINGS_DEFAULTS: {
  enabled: boolean;
  approval: PrintApprovalMode;
  perDeviceLimit: number;
  paperSizes: PrintPaperSize[];
} = {
  enabled: false,
  approval: 'manual',
  perDeviceLimit: 1,
  paperSizes: ['4r'],
};

export const printPaperSizeSchema = z.enum(PRINT_PAPER_SIZE_CODES);
export const printOrderStatusSchema = z.enum(PRINT_ORDER_STATUSES);

/** Paper sizes on offer: at least one, no repeats, kept in PRINT_PAPER_SIZES order. */
const paperSizesSchema = z
  .array(printPaperSizeSchema)
  .min(1)
  .max(PRINT_PAPER_SIZE_CODES.length)
  .refine((sizes) => new Set(sizes).size === sizes.length, { error: 'must not repeat' })
  .transform((sizes) => PRINT_PAPER_SIZE_CODES.filter((code) => sizes.includes(code)));

// --- photographer: settings -----------------------------------------------------------------------

export const printSettingsSchema = z.object({
  /** Viewers of every share of this photographer see the print button. */
  enabled: z.boolean(),
  approval: z.enum(PRINT_APPROVAL_MODES),
  /** Prints one device (the anon_id cookie) may order per share; rejected orders don't count. */
  perDeviceLimit: z.number().int().min(1).max(PRINT_DEVICE_LIMIT_MAX),
  paperSizes: paperSizesSchema,
});
export type PrintSettings = z.output<typeof printSettingsSchema>;

/** PUT /print/settings: the whole settings. */
export const updatePrintSettingsBodySchema = printSettingsSchema;
export type UpdatePrintSettingsBody = z.input<typeof updatePrintSettingsBodySchema>;

// --- photographer: orders -------------------------------------------------------------------------

/** One order as the photographer's studio shows it. */
export const ownerPrintOrderSchema = z.object({
  id: idSchema,
  /** Per photographer, counting up from 1: what the viewer is told ("#12"). */
  orderNumber: z.number().int().positive(),
  status: printOrderStatusSchema,
  paperSize: printPaperSizeSchema,
  /** What the viewer typed so the print can be handed over (name, bib number), or null. */
  customerName: z.string().nullable(),
  /**
   * Four characters that tell devices apart (from the device's anon id, not reversible to it):
   * orders with the same label came from the same phone.
   */
  deviceLabel: z.string().length(4),
  shareId: idSchema,
  /** The shared event's (folder's or file's) current name. */
  eventName: z.string(),
  fileId: idSchema,
  fileName: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** thumb.webp; null once the file is trashed or gone. */
  thumbUrl: signedUrlSchema.nullable(),
  /**
   * The image to print (the original; web.jpg when the original isn't a browser image), view
   * TTL; null once the file is trashed or gone (the order can then only be rejected).
   */
  printUrl: signedUrlSchema.nullable(),
  printCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  /** When it was allowed or rejected (null while pending, and for orders queued at once). */
  decidedAt: isoDateTimeSchema.nullable(),
  /** Last time it was printed. */
  printedAt: isoDateTimeSchema.nullable(),
});
export type OwnerPrintOrder = z.output<typeof ownerPrintOrderSchema>;

export const listPrintOrdersQuerySchema = z.object({
  /** Only orders in this status; all of them when absent. */
  status: printOrderStatusSchema.optional(),
});
export type ListPrintOrdersQuery = z.input<typeof listPrintOrdersQuerySchema>;

export const printOrderCountsSchema = z.object(
  Object.fromEntries(PRINT_ORDER_STATUSES.map((s) => [s, z.number().int().nonnegative()])) as {
    [K in (typeof PRINT_ORDER_STATUSES)[number]]: z.ZodNumber;
  },
);
export type PrintOrderCounts = z.output<typeof printOrderCountsSchema>;

export const listPrintOrdersResponseSchema = z.object({
  /** Newest first, at most PRINT_ORDER_LIST_LIMIT. */
  items: z.array(ownerPrintOrderSchema),
  /** All of the photographer's orders by status (not only the listed ones). */
  counts: printOrderCountsSchema,
});
export type ListPrintOrdersResponse = z.output<typeof listPrintOrdersResponseSchema>;

/**
 * POST /print/orders/:id/print. `onlyQueued` (a print station printing on its own): take the
 * order only while it is `queued`, so two stations never print it twice (CONFLICT otherwise).
 * Without it (the photographer's own print button) a pending order is allowed and printed, and a
 * printed one is printed again. A rejected order is always CONFLICT.
 */
export const printPrintOrderBodySchema = z.object({ onlyQueued: z.boolean().default(false) });
export type PrintPrintOrderBody = z.input<typeof printPrintOrderBodySchema>;

// --- public: the share page -------------------------------------------------------------------------

/** One of this device's orders on the share page. */
export const viewerPrintOrderSchema = z.object({
  id: idSchema,
  orderNumber: z.number().int().positive(),
  fileId: idSchema,
  paperSize: printPaperSizeSchema,
  status: printOrderStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type ViewerPrintOrder = z.output<typeof viewerPrintOrderSchema>;

/** GET /s/:token/prints: whether this share takes print orders, and this device's orders. */
export const sharePrintsResponseSchema = z.object({
  /** Null when the photographer has print orders off: show no print button. */
  offer: z
    .object({
      paperSizes: z.array(printPaperSizeSchema).min(1),
      perDeviceLimit: z.number().int().positive(),
      approval: z.enum(PRINT_APPROVAL_MODES),
    })
    .nullable(),
  /** This device's orders on this share that count against the limit (not rejected). */
  used: z.number().int().nonnegative(),
  /** This device's orders on this share, newest first (rejected ones included). */
  orders: z.array(viewerPrintOrderSchema),
});
export type SharePrintsResponse = z.output<typeof sharePrintsResponseSchema>;

export const createPrintOrderBodySchema = z.object({
  fileId: idSchema,
  paperSize: printPaperSizeSchema,
  customerName: z
    .string()
    .trim()
    .max(PRINT_CUSTOMER_NAME_MAX_LENGTH)
    .optional()
    .transform((name) => (name === undefined || name === '' ? null : name)),
});
export type CreatePrintOrderBody = z.input<typeof createPrintOrderBodySchema>;

export const createPrintOrderResponseSchema = z.object({
  order: viewerPrintOrderSchema,
  used: z.number().int().nonnegative(),
  perDeviceLimit: z.number().int().positive(),
});
export type CreatePrintOrderResponse = z.output<typeof createPrintOrderResponseSchema>;

/** Paper sizes in PRINT_PAPER_SIZES order. */
export function sortPaperSizes(sizes: readonly PrintPaperSize[]): PrintPaperSize[] {
  return PRINT_PAPER_SIZE_CODES.filter((code) => sizes.includes(code));
}
