import { NextResponse } from "next/server";
import { StudioBrowserError } from "@/lib/studio-browser";

export function studioBrowserApiError(error: unknown): NextResponse {
  if (error instanceof StudioBrowserError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return NextResponse.json(
    {
      error: "browser_request_failed",
      message: "The isolated Browser request could not be completed.",
    },
    { status: 500 },
  );
}
