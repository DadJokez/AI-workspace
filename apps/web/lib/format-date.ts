const PRODUCT_LOCALE = "en-US";

type DateInput = Date | string | number;

const dateFormatter = new Intl.DateTimeFormat(PRODUCT_LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const monthDayFormatter = new Intl.DateTimeFormat(PRODUCT_LOCALE, {
  month: "short",
  day: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat(PRODUCT_LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDate(value: DateInput): string {
  return format(value, dateFormatter);
}

export function formatMonthDay(value: DateInput): string {
  return format(value, monthDayFormatter);
}

export function formatDateTime(value: DateInput): string {
  return format(value, dateTimeFormatter);
}

function format(value: DateInput, formatter: Intl.DateTimeFormat): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : formatter.format(date);
}
