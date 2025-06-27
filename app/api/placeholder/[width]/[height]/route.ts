import { NextRequest, NextResponse } from "next/server";

interface RouteParams {
  params: {
    width: string;
    height: string;
  };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { width, height } = params;
  const w = parseInt(width) || 200;
  const h = parseInt(height) || 200;
  
  // Create a simple SVG placeholder
  const svg = `
    <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${w}" height="${h}" fill="#f3f4f6"/>
      <text 
        x="50%" 
        y="50%" 
        dominant-baseline="middle" 
        text-anchor="middle" 
        font-family="system-ui, -apple-system, sans-serif" 
        font-size="14" 
        fill="#9ca3af"
      >
        ${w} × ${h}
      </text>
    </svg>
  `;
  
  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}