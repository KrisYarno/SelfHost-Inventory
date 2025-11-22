"use client";

import { AuditActionType } from "@/lib/audit";
import { inventory_logs_logType } from "@prisma/client";

type Tone = {
  label: string;
  className: string;
};

export function getAuditTone(actionType: string): Tone {
  const map: Record<string, Tone> = {
    PRODUCT_CREATE: { label: "Product Create", className: "bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-500 dark:text-white dark:border-transparent" },
    PRODUCT_UPDATE: { label: "Product Update", className: "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-500 dark:text-white dark:border-transparent" },
    PRODUCT_DELETE: { label: "Product Delete", className: "bg-rose-100 text-rose-800 border border-rose-200 dark:bg-rose-600 dark:text-white dark:border-transparent" },
    PRODUCT_BULK_DELETE: { label: "Product Bulk Delete", className: "bg-rose-200 text-rose-900 border border-rose-300 dark:bg-rose-700 dark:text-white dark:border-transparent" },

    INVENTORY_BULK_UPDATE: { label: "Inventory Bulk Update", className: "bg-violet-100 text-violet-800 border border-violet-200 dark:bg-violet-600 dark:text-white dark:border-transparent" },
    INVENTORY_TRANSFER: { label: "Inventory Transfer", className: "bg-slate-200 text-slate-900 border border-slate-300 dark:bg-slate-600 dark:text-white dark:border-transparent" },
    INVENTORY_TRANSFER_AUTO_ADD: { label: "Transfer Auto Add", className: "bg-slate-200 text-slate-800 border border-slate-300 dark:bg-slate-500 dark:text-white dark:border-transparent" },
    INVENTORY_DEDUCTION: { label: "Inventory Deduction", className: "bg-rose-100 text-rose-800 border border-rose-200 dark:bg-rose-500 dark:text-white dark:border-transparent" },
    INVENTORY_STOCK_IN: { label: "Stock In", className: "bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-600 dark:text-white dark:border-transparent" },
    INVENTORY_ADJUSTMENT: { label: "Inventory Adjustment", className: "bg-indigo-100 text-indigo-800 border border-indigo-200 dark:bg-indigo-500 dark:text-white dark:border-transparent" },

    USER_APPROVAL: { label: "User Approval", className: "bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-500 dark:text-white dark:border-transparent" },
    USER_REJECTION: { label: "User Rejection", className: "bg-rose-100 text-rose-800 border border-rose-200 dark:bg-rose-500 dark:text-white dark:border-transparent" },
    USER_DELETION: { label: "User Deletion", className: "bg-rose-200 text-rose-900 border border-rose-300 dark:bg-rose-700 dark:text-white dark:border-transparent" },
    USER_UPDATE: { label: "User Update", className: "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-500 dark:text-white dark:border-transparent" },
    USER_BULK_APPROVAL: { label: "Bulk User Approval", className: "bg-emerald-200 text-emerald-900 border border-emerald-300 dark:bg-emerald-600 dark:text-white dark:border-transparent" },
    USER_BULK_REJECTION: { label: "Bulk User Rejection", className: "bg-rose-200 text-rose-900 border border-rose-300 dark:bg-rose-700 dark:text-white dark:border-transparent" },

    DATA_EXPORT: { label: "Data Export", className: "bg-sky-100 text-sky-800 border border-sky-200 dark:bg-sky-600 dark:text-white dark:border-transparent" },
    SYSTEM_MAINTENANCE: { label: "System Maintenance", className: "bg-slate-200 text-slate-900 border border-slate-300 dark:bg-slate-700 dark:text-white dark:border-transparent" },
    EMAIL_SENT: { label: "Email Sent", className: "bg-sky-100 text-sky-800 border border-sky-200 dark:bg-sky-600 dark:text-white dark:border-transparent" },
    SETTINGS_UPDATE: { label: "Settings Update", className: "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-600 dark:text-white dark:border-transparent" },
    LOCATION_CREATE: { label: "Location Create", className: "bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-500 dark:text-white dark:border-transparent" },
    LOCATION_UPDATE: { label: "Location Update", className: "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-500 dark:text-white dark:border-transparent" },
    LOCATION_DELETE: { label: "Location Delete", className: "bg-rose-200 text-rose-900 border border-rose-300 dark:bg-rose-700 dark:text-white dark:border-transparent" },
  };

  return map[actionType as AuditActionType] ?? {
    label: actionType.replace(/_/g, " "),
    className: "bg-slate-200 text-slate-900 border border-slate-300 dark:bg-slate-700 dark:text-white dark:border-transparent",
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
