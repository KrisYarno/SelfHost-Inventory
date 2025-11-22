"use client";

import { AuditActionType } from "@/lib/audit";
import { inventory_logs_logType } from "@prisma/client";

type Tone = {
  label: string;
  className: string;
};

export function getAuditTone(actionType: string): Tone {
  const map: Record<string, Tone> = {
    PRODUCT_CREATE: { label: "Product Create", className: "bg-emerald-500 text-white" },
    PRODUCT_UPDATE: { label: "Product Update", className: "bg-amber-500 text-white" },
    PRODUCT_DELETE: { label: "Product Delete", className: "bg-red-500 text-white" },
    PRODUCT_BULK_DELETE: { label: "Product Bulk Delete", className: "bg-red-600 text-white" },

    INVENTORY_BULK_UPDATE: { label: "Inventory Bulk Update", className: "bg-purple-600 text-white" },
    INVENTORY_TRANSFER: { label: "Inventory Transfer", className: "bg-slate-600 text-white" },
    INVENTORY_TRANSFER_AUTO_ADD: { label: "Transfer Auto Add", className: "bg-slate-500 text-white" },
    INVENTORY_DEDUCTION: { label: "Inventory Deduction", className: "bg-rose-500 text-white" },
    INVENTORY_STOCK_IN: { label: "Stock In", className: "bg-emerald-600 text-white" },
    INVENTORY_ADJUSTMENT: { label: "Inventory Adjustment", className: "bg-indigo-500 text-white" },

    USER_APPROVAL: { label: "User Approval", className: "bg-emerald-500 text-white" },
    USER_REJECTION: { label: "User Rejection", className: "bg-red-500 text-white" },
    USER_DELETION: { label: "User Deletion", className: "bg-red-600 text-white" },
    USER_UPDATE: { label: "User Update", className: "bg-amber-500 text-white" },
    USER_BULK_APPROVAL: { label: "Bulk User Approval", className: "bg-emerald-600 text-white" },
    USER_BULK_REJECTION: { label: "Bulk User Rejection", className: "bg-red-600 text-white" },

    DATA_EXPORT: { label: "Data Export", className: "bg-sky-500 text-white" },
    SYSTEM_MAINTENANCE: { label: "System Maintenance", className: "bg-slate-700 text-white" },
    EMAIL_SENT: { label: "Email Sent", className: "bg-sky-600 text-white" },
    SETTINGS_UPDATE: { label: "Settings Update", className: "bg-amber-600 text-white" },
    LOCATION_CREATE: { label: "Location Create", className: "bg-emerald-500 text-white" },
    LOCATION_UPDATE: { label: "Location Update", className: "bg-amber-500 text-white" },
    LOCATION_DELETE: { label: "Location Delete", className: "bg-red-600 text-white" },
  };

  return map[actionType as AuditActionType] ?? {
    label: actionType.replace(/_/g, " "),
    className: "bg-gray-600 text-white",
  };
}

export function getInventoryLogTone(logType: inventory_logs_logType | string, delta: number): Tone {
  if (logType === "TRANSFER") {
    return { label: "Transfer", className: "bg-slate-600 text-white" };
  }
  if (logType === "ADJUSTMENT") {
    return delta >= 0
      ? { label: "Stock In", className: "bg-emerald-600 text-white" }
      : { label: "Stock Out", className: "bg-rose-500 text-white" };
  }
  if (logType === "AUTO_ADJUST") {
    return { label: "Transfer Auto Add", className: "bg-slate-500 text-white" };
  }
  if (logType === "DEDUCTION") {
    return { label: "Deduction", className: "bg-rose-500 text-white" };
  }
  return { label: String(logType), className: "bg-gray-600 text-white" };
}
