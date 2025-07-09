"use client";

import { useState, useEffect } from "react";
import { Plus, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface AdjustmentInputProps {
  value: number;
  onChange: (value: number) => void;
  currentQuantity: number;
  min?: number;
  max?: number;
  productName?: string;
}

export function AdjustmentInput({
  value,
  onChange,
  currentQuantity,
  min = -currentQuantity,
  max = 9999,
  productName = "product",
}: AdjustmentInputProps) {
  const [inputValue, setInputValue] = useState(value.toString());
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (!isEditing) {
      setInputValue(value.toString());
    }
  }, [value, isEditing]);

  const handleIncrement = () => {
    const newValue = Math.min(value + 1, max);
    onChange(newValue);
  };

  const handleDecrement = () => {
    const newValue = Math.max(value - 1, min);
    onChange(newValue);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    
    // Allow empty string, minus sign, or valid numbers
    if (val === "" || val === "-" || /^-?\d+$/.test(val)) {
      setInputValue(val);
    }
  };

  const handleInputBlur = () => {
    setIsEditing(false);
    
    let numValue = parseInt(inputValue, 10);
    
    if (isNaN(numValue)) {
      numValue = 0;
    } else {
      numValue = Math.max(min, Math.min(numValue, max));
    }
    
    onChange(numValue);
    setInputValue(numValue.toString());
  };

  const handleInputFocus = () => {
    setIsEditing(true);
    if (value === 0) {
      setInputValue("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleInputBlur();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      handleIncrement();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      handleDecrement();
    }
  };

  return (
    <div className="flex items-center gap-1" role="group" aria-label={`Adjust quantity for ${productName}`}>
      <Button
        variant="outline"
        size="icon"
        onClick={handleDecrement}
        disabled={value <= min}
        className="h-8 w-8"
        aria-label={`Decrease quantity (current adjustment: ${value})`}
        title="Decrease quantity"
      >
        <Minus className="h-3 w-3" aria-hidden="true" />
      </Button>

      <Input
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onBlur={handleInputBlur}
        onFocus={handleInputFocus}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-20 text-center h-8",
          value > 0 && "text-green-600 border-green-500/50",
          value < 0 && "text-red-600 border-red-500/50"
        )}
        aria-label={`Quantity adjustment value`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${value > 0 ? "+" : ""}${value} units`}
        role="spinbutton"
      />

      <Button
        variant="outline"
        size="icon"
        onClick={handleIncrement}
        disabled={value >= max}
        className="h-8 w-8"
        aria-label={`Increase quantity (current adjustment: ${value})`}
        title="Increase quantity"
      >
        <Plus className="h-3 w-3" aria-hidden="true" />
      </Button>
    </div>
  );
}