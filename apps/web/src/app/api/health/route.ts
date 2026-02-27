import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "@mr-agent/web",
    timestamp: new Date().toISOString(),
  });
}
