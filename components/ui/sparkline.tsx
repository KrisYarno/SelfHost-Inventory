"use client";

import { ResponsiveContainer, LineChart, Line } from "recharts";

interface SparklineProps {
  /** Array of numeric values representing the trend */
  data: number[];
  /** Width in pixels (default 60) */
  width?: number;
  /** Height in pixels (default 20) */
  height?: number;
  /** Override the auto-detected color */
  color?: string;
  /** Class name for the wrapper */
  className?: string;
}

function getTrendColor(data: number[]): string {
  if (data.length < 2) return "hsl(0, 0%, 60%)"; // gray
  const first = data[0];
  const last = data[data.length - 1];
  const diff = last - first;
  const threshold = Math.max(Math.abs(first) * 0.02, 1); // 2% or at least 1
  if (diff > threshold) return "hsl(142, 71%, 45%)"; // green
  if (diff < -threshold) return "hsl(0, 84%, 60%)"; // red
  return "hsl(0, 0%, 60%)"; // gray / flat
}

export function Sparkline({
  data,
  width = 60,
  height = 20,
  color,
  className,
}: SparklineProps) {
  if (!data || data.length < 2) return null;

  const chartData = data.map((value, index) => ({ index, value }));
  const lineColor = color ?? getTrendColor(data);

  return (
    <div className={className} style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={lineColor}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
