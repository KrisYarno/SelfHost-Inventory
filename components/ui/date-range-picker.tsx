"use client";

import * as React from "react";
import { format, subDays, startOfMonth, endOfMonth, startOfDay, endOfDay } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { DateRange } from "react-day-picker";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type DateRangePreset = 
  | "today" 
  | "yesterday" 
  | "last7days" 
  | "last30days" 
  | "thisMonth" 
  | "lastMonth" 
  | "custom";

interface DateRangePickerProps {
  className?: string;
  date?: DateRange;
  onDateChange: (date: DateRange | undefined, preset: DateRangePreset) => void;
}

const presets: { label: string; value: DateRangePreset; getRange: () => DateRange }[] = [
  {
    label: "Today",
    value: "today",
    getRange: () => ({
      from: startOfDay(new Date()),
      to: endOfDay(new Date()),
    }),
  },
  {
    label: "Yesterday",
    value: "yesterday",
    getRange: () => ({
      from: startOfDay(subDays(new Date(), 1)),
      to: endOfDay(subDays(new Date(), 1)),
    }),
  },
  {
    label: "Last 7 days",
    value: "last7days",
    getRange: () => ({
      from: startOfDay(subDays(new Date(), 6)),
      to: endOfDay(new Date()),
    }),
  },
  {
    label: "Last 30 days",
    value: "last30days",
    getRange: () => ({
      from: startOfDay(subDays(new Date(), 29)),
      to: endOfDay(new Date()),
    }),
  },
  {
    label: "This month",
    value: "thisMonth",
    getRange: () => ({
      from: startOfMonth(new Date()),
      to: endOfDay(new Date()),
    }),
  },
  {
    label: "Last month",
    value: "lastMonth",
    getRange: () => {
      const lastMonth = subDays(startOfMonth(new Date()), 1);
      return {
        from: startOfMonth(lastMonth),
        to: endOfMonth(lastMonth),
      };
    },
  },
];

export function DateRangePicker({
  className,
  date,
  onDateChange,
}: DateRangePickerProps) {
  const [selectedPreset, setSelectedPreset] = React.useState<DateRangePreset>("last7days");
  const [isOpen, setIsOpen] = React.useState(false);

  const handlePresetChange = (preset: DateRangePreset) => {
    setSelectedPreset(preset);
    if (preset !== "custom") {
      const presetConfig = presets.find(p => p.value === preset);
      if (presetConfig) {
        const range = presetConfig.getRange();
        onDateChange(range, preset);
        setIsOpen(false);
      }
    }
  };

  const handleCustomDateChange = (newDate: DateRange | undefined) => {
    setSelectedPreset("custom");
    onDateChange(newDate, "custom");
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Select value={selectedPreset} onValueChange={handlePresetChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {presets.map((preset) => (
            <SelectItem key={preset.value} value={preset.value}>
              {preset.label}
            </SelectItem>
          ))}
          <SelectItem value="custom">Custom range</SelectItem>
        </SelectContent>
      </Select>

      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "justify-start text-left font-normal",
              !date && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {date?.from ? (
              date.to ? (
                <>
                  {format(date.from, "LLL dd, y")} -{" "}
                  {format(date.to, "LLL dd, y")}
                </>
              ) : (
                format(date.from, "LLL dd, y")
              )
            ) : (
              <span>Pick a date range</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            initialFocus
            mode="range"
            defaultMonth={date?.from}
            selected={date}
            onSelect={handleCustomDateChange}
            numberOfMonths={2}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}