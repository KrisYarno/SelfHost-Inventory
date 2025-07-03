"use client";

import { useState } from "react";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Download, X } from "lucide-react";
import { exportToCSV, generateExportFilename } from "@/lib/export-utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LineChartComponent, BarChartComponent } from "./inventory-chart";

interface DrillDownModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  data: any;
  type: "product" | "date" | "user" | "location";
}

export function DrillDownModal({
  isOpen,
  onClose,
  title,
  description,
  data,
  type,
}: DrillDownModalProps) {
  const [activeTab, setActiveTab] = useState("table");

  const handleExport = () => {
    if (!data) return;
    
    const filename = generateExportFilename(
      `drill-down-${type}-${title.toLowerCase().replace(/\s+/g, "-")}`,
      "csv"
    );
    
    if (Array.isArray(data)) {
      exportToCSV(data, filename);
    } else if (data.details) {
      exportToCSV(data.details, filename);
    }
  };

  const renderContent = () => {
    switch (type) {
      case "product":
        return renderProductDrillDown();
      case "date":
        return renderDateDrillDown();
      case "user":
        return renderUserDrillDown();
      case "location":
        return renderLocationDrillDown();
      default:
        return null;
    }
  };

  const renderProductDrillDown = () => {
    if (!data) return null;

    return (
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="table">Details</TabsTrigger>
          <TabsTrigger value="chart">Trends</TabsTrigger>
        </TabsList>
        
        <TabsContent value="table" className="mt-4">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Current Stock</p>
                <p className="text-2xl font-semibold">{data.currentStock || 0}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">30-Day Movement</p>
                <p className="text-2xl font-semibold">{data.movement30Days || 0}</p>
              </div>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.transactions?.map((transaction: any) => (
                  <TableRow key={transaction.id}>
                    <TableCell>
                      {format(new Date(transaction.date), "MMM dd, yyyy")}
                    </TableCell>
                    <TableCell className="capitalize">
                      {transaction.type.replace("_", " ")}
                    </TableCell>
                    <TableCell className={transaction.quantity > 0 ? "text-green-600" : "text-red-600"}>
                      {transaction.quantity > 0 ? "+" : ""}{transaction.quantity}
                    </TableCell>
                    <TableCell>{transaction.user}</TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {transaction.notes || "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
        
        <TabsContent value="chart" className="mt-4">
          {data.dailyTrend && (
            <LineChartComponent
              data={data.dailyTrend}
              title="Daily Stock Level"
              description="Stock level over time"
            />
          )}
        </TabsContent>
      </Tabs>
    );
  };

  const renderDateDrillDown = () => {
    if (!data) return null;

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Stock In</p>
            <p className="text-2xl font-semibold text-green-600">+{data.totalStockIn || 0}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Stock Out</p>
            <p className="text-2xl font-semibold text-red-600">-{data.totalStockOut || 0}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Adjustments</p>
            <p className="text-2xl font-semibold">{data.totalAdjustments || 0}</p>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Quantity</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Location</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.activities?.map((activity: any) => (
              <TableRow key={activity.id}>
                <TableCell>
                  {format(new Date(activity.timestamp), "HH:mm")}
                </TableCell>
                <TableCell>{activity.product}</TableCell>
                <TableCell className="capitalize">
                  {activity.type.replace("_", " ")}
                </TableCell>
                <TableCell className={activity.quantity > 0 ? "text-green-600" : "text-red-600"}>
                  {activity.quantity > 0 ? "+" : ""}{activity.quantity}
                </TableCell>
                <TableCell>{activity.user}</TableCell>
                <TableCell>{activity.location}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  };

  const renderUserDrillDown = () => {
    if (!data) return null;

    return (
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="table">Activity Log</TabsTrigger>
          <TabsTrigger value="chart">Activity Pattern</TabsTrigger>
        </TabsList>
        
        <TabsContent value="table" className="mt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.activities?.map((activity: any) => (
                <TableRow key={activity.id}>
                  <TableCell>
                    {format(new Date(activity.date), "MMM dd, yyyy HH:mm")}
                  </TableCell>
                  <TableCell>{activity.product}</TableCell>
                  <TableCell className="capitalize">
                    {activity.type.replace("_", " ")}
                  </TableCell>
                  <TableCell className={activity.quantity > 0 ? "text-green-600" : "text-red-600"}>
                    {activity.quantity > 0 ? "+" : ""}{activity.quantity}
                  </TableCell>
                  <TableCell>{activity.location}</TableCell>
                  <TableCell className="max-w-[200px] truncate">
                    {activity.notes || "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
        
        <TabsContent value="chart" className="mt-4">
          {data.activityPattern && (
            <BarChartComponent
              data={data.activityPattern}
              title="Activity by Type"
              description="Distribution of user activities"
            />
          )}
        </TabsContent>
      </Tabs>
    );
  };

  const renderLocationDrillDown = () => {
    if (!data) return null;

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Total Products</p>
            <p className="text-2xl font-semibold">{data.totalProducts || 0}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Total Stock</p>
            <p className="text-2xl font-semibold">{data.totalStock || 0}</p>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Current Stock</TableHead>
              <TableHead>Last Activity</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.products?.map((product: any) => (
              <TableRow key={product.id}>
                <TableCell>{product.name}</TableCell>
                <TableCell>{product.stock}</TableCell>
                <TableCell>
                  {format(new Date(product.lastActivity), "MMM dd, yyyy")}
                </TableCell>
                <TableCell>
                  <span
                    className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                      product.stock === 0
                        ? "bg-red-100 text-red-800"
                        : product.stock < 10
                        ? "bg-yellow-100 text-yellow-800"
                        : "bg-green-100 text-green-800"
                    }`}
                  >
                    {product.stock === 0
                      ? "Out of Stock"
                      : product.stock < 10
                      ? "Low Stock"
                      : "In Stock"}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>{title}</DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
              >
                <Download className="h-4 w-4 mr-1" />
                Export
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {description && (
            <DialogDescription>{description}</DialogDescription>
          )}
        </DialogHeader>
        
        <div className="mt-4">
          {renderContent()}
        </div>
      </DialogContent>
    </Dialog>
  );
}