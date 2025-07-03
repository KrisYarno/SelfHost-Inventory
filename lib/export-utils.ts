import { format } from "date-fns";

// Export data to CSV
export function exportToCSV(
  data: any[],
  filename: string,
  columns?: { key: string; label: string }[]
) {
  if (!data || data.length === 0) {
    console.warn("No data to export");
    return;
  }

  // If columns not provided, use all keys from first object
  if (!columns) {
    const firstItem = data[0];
    columns = Object.keys(firstItem).map(key => ({ key, label: key }));
  }

  // Create CSV header
  const header = columns.map(col => col.label).join(",");
  
  // Create CSV rows
  const rows = data.map(item => 
    columns!.map(col => {
      const value = item[col.key];
      // Handle values that might contain commas or quotes
      if (typeof value === "string" && (value.includes(",") || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value ?? "";
    }).join(",")
  );

  // Combine header and rows
  const csv = [header, ...rows].join("\n");

  // Create blob and download
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Export chart as image
export async function exportChartAsImage(
  chartElement: HTMLElement,
  filename: string,
  format: "png" | "jpeg" = "png"
) {
  try {
    // Using html2canvas library
    const html2canvas = (await import("html2canvas")).default;
    
    const canvas = await html2canvas(chartElement, {
      backgroundColor: null,
      scale: 2, // Higher quality
    });

    // Convert to blob
    canvas.toBlob((blob) => {
      if (!blob) return;
      
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    }, `image/${format}`);
  } catch (error) {
    console.error("Error exporting chart:", error);
  }
}

// Export data as JSON
export function exportToJSON(data: any, filename: string) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  
  URL.revokeObjectURL(url);
}

// Generate filename with date
export function generateExportFilename(prefix: string, extension: string, dateRange?: { from?: Date; to?: Date }) {
  const timestamp = format(new Date(), "yyyy-MM-dd_HH-mm");
  
  if (dateRange?.from && dateRange?.to) {
    const fromDate = format(dateRange.from, "yyyy-MM-dd");
    const toDate = format(dateRange.to, "yyyy-MM-dd");
    return `${prefix}_${fromDate}_to_${toDate}_${timestamp}.${extension}`;
  }
  
  return `${prefix}_${timestamp}.${extension}`;
}