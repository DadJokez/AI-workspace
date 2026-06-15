import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    databaseUrl: process.env.DATABASE_URL,
    nextAuthSecret: process.env.NEXTAUTH_SECRET,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
    environmentKeys: Object.keys(process.env).sort(),
  });
}
