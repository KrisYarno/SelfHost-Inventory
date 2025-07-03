"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ChartProps {
  data: any[];
  title: string;
  description?: string;
  onClick?: (data: any) => void;
}

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8'];

export function LineChartComponent({ data, title, description, onClick }: ChartProps) {
  const handleClick = (data: any) => {
    if (onClick && data && data.activePayload && data.activePayload[0]) {
      onClick(data.activePayload[0].payload);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} onClick={handleClick}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis 
              dataKey="date" 
              style={{ fontSize: '12px' }}
            />
            <YAxis style={{ fontSize: '12px' }} />
            <Tooltip />
            <Legend />
            <Line 
              type="monotone" 
              dataKey="quantity" 
              stroke="#8884d8" 
              strokeWidth={2}
              name="Stock Level"
              cursor="pointer"
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function BarChartComponent({ data, title, description }: ChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis 
              dataKey="product" 
              style={{ fontSize: '12px' }}
              angle={-45}
              textAnchor="end"
              height={100}
            />
            <YAxis style={{ fontSize: '12px' }} />
            <Tooltip />
            <Legend />
            <Bar dataKey="stockIn" fill="#00C49F" name="Stock In" />
            <Bar dataKey="stockOut" fill="#FF8042" name="Stock Out" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function PieChartComponent({ data, title, description }: ChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({name, percent}) => `${name} ${((percent || 0) * 100).toFixed(0)}%`}
              outerRadius={80}
              fill="#8884d8"
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function ActivityBarChart({ data, title, description, onClick }: ChartProps) {
  const handleClick = (data: any) => {
    if (onClick && data && data.activePayload && data.activePayload[0]) {
      onClick(data.activePayload[0].payload);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data} onClick={handleClick}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis 
              dataKey="date" 
              style={{ fontSize: '12px' }}
            />
            <YAxis style={{ fontSize: '12px' }} />
            <Tooltip />
            <Legend />
            <Bar dataKey="stockIn" stackId="a" fill="#00C49F" name="Stock In" cursor="pointer" />
            <Bar dataKey="stockOut" stackId="a" fill="#FF8042" name="Stock Out" cursor="pointer" />
            <Bar dataKey="adjustments" stackId="a" fill="#0088FE" name="Adjustments" cursor="pointer" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}