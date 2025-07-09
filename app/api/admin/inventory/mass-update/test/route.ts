import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ 
    message: "Mass update test endpoint is working",
    timestamp: new Date().toISOString()
  });
}