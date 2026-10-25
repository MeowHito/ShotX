import exifReader from 'exif-reader';

const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/** `+07:00` -> minutes east of UTC. Null when malformed. */
export function parseUtcOffset(value: string): number | null {
  const match = OFFSET.exec(value.trim());
  if (match === null) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  if (minutes > 14 * 60) return null;
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * When the photo was taken, from EXIF DateTimeOriginal (falling back to DateTimeDigitized and
 * the IFD0 DateTime). EXIF stores camera wall-clock time; OffsetTimeOriginal (EXIF 2.31) gives
 * the zone, otherwise `defaultOffset` (WORKER_EXIF_DEFAULT_UTC_OFFSET) is assumed. Null when there
 * is no usable date: missing or unparsable EXIF is normal, never an error.
 */
export function takenAtFromExif(exif: Buffer | undefined, defaultOffset: string): Date | null {
  if (exif === undefined || exif.length === 0) return null;
  let parsed: ReturnType<typeof exifReader>;
  try {
    parsed = exifReader(exif);
  } catch {
    return null;
  }
  const candidates: Array<[unknown, unknown]> = [
    [parsed.Photo?.DateTimeOriginal, parsed.Photo?.OffsetTimeOriginal],
    [parsed.Photo?.DateTimeDigitized, parsed.Photo?.OffsetTimeDigitized],
    [parsed.Image?.DateTime, parsed.Photo?.OffsetTime],
  ];
  for (const [wallClock, offset] of candidates) {
    if (!(wallClock instanceof Date) || Number.isNaN(wallClock.getTime())) continue;
    // exif-reader reads the wall-clock fields as if they were UTC.
    const minutes =
      (typeof offset === 'string' ? parseUtcOffset(offset) : null) ?? parseUtcOffset(defaultOffset);
    if (minutes === null) continue;
    const takenAt = new Date(wallClock.getTime() - minutes * 60_000);
    // Cameras with an unset clock write 0000:00:00 or 1970; neither is a real capture time.
    if (takenAt.getUTCFullYear() < 1990) continue;
    return takenAt;
  }
  return null;
}
