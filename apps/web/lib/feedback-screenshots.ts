export const MAX_FEEDBACK_SCREENSHOT_MB = 5;
export const MAX_FEEDBACK_SCREENSHOT_BYTES =
  MAX_FEEDBACK_SCREENSHOT_MB * 1024 * 1024;
export const MAX_FEEDBACK_SCREENSHOT_DATA_URL_CHARS =
  Math.ceil(MAX_FEEDBACK_SCREENSHOT_BYTES / 3) * 4 + 128;
export const FEEDBACK_SCREENSHOT_TOO_LARGE_MESSAGE = `Screenshot is too large. Keep it under ${MAX_FEEDBACK_SCREENSHOT_MB} MB.`;

export const ALLOWED_FEEDBACK_SCREENSHOT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
