'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AccordionContextValue {
  value: string[];
  onValueChange: (value: string) => void;
}

const AccordionContext = React.createContext<AccordionContextValue | undefined>(undefined);

interface AccordionProps {
  type?: 'single' | 'multiple';
  value?: string | string[];
  onValueChange?: (value: string | string[]) => void;
  defaultValue?: string | string[];
  children: React.ReactNode;
  className?: string;
}

export function Accordion({
  type = 'single',
  value: controlledValue,
  onValueChange,
  defaultValue,
  children,
  className,
}: AccordionProps) {
  const [value, setValue] = React.useState<string[]>(() => {
    if (defaultValue) {
      return Array.isArray(defaultValue) ? defaultValue : [defaultValue];
    }
    return [];
  });

  const finalValue = React.useMemo(() => {
    if (controlledValue !== undefined) {
      return Array.isArray(controlledValue) ? controlledValue : [controlledValue];
    }
    return value;
  }, [controlledValue, value]);

  const handleValueChange = React.useCallback((itemValue: string) => {
    const newValue = type === 'single'
      ? finalValue.includes(itemValue) ? [] : [itemValue]
      : finalValue.includes(itemValue)
        ? finalValue.filter(v => v !== itemValue)
        : [...finalValue, itemValue];

    if (controlledValue === undefined) {
      setValue(newValue);
    }

    if (onValueChange) {
      onValueChange(type === 'single' ? newValue[0] || '' : newValue);
    }
  }, [finalValue, type, controlledValue, onValueChange]);

  return (
    <AccordionContext.Provider value={{ value: finalValue, onValueChange: handleValueChange }}>
      <div className={cn('space-y-2', className)}>
        {children}
      </div>
    </AccordionContext.Provider>
  );
}

interface AccordionItemProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

export function AccordionItem({ value, children, className }: AccordionItemProps) {
  const context = React.useContext(AccordionContext);
  if (!context) {
    throw new Error('AccordionItem must be used within an Accordion');
  }

  const isOpen = context.value.includes(value);
  // Names the content for the trigger's aria-controls (F0-8).
  const contentId = React.useId();

  return (
    <div
      className={cn(
        'border rounded-lg overflow-hidden transition-colors',
        isOpen && 'border-primary/20 bg-muted/30',
        className
      )}
    >
      {React.Children.map(children, child => {
        if (React.isValidElement(child)) {
          return React.cloneElement(child as React.ReactElement<any>, {
            isOpen,
            value,
            contentId,
          });
        }
        return child;
      })}
    </div>
  );
}

interface AccordionTriggerProps {
  children: React.ReactNode;
  className?: string;
  isOpen?: boolean;
  value?: string;
  contentId?: string;
}

export function AccordionTrigger({ 
  children, 
  className,
  isOpen: isOpenProp,
  value,
  contentId,
}: AccordionTriggerProps) {
  const context = React.useContext(AccordionContext);
  const isOpen = isOpenProp ?? false;

  const handleClick = () => {
    if (context && value) {
      context.onValueChange(value);
    }
  };

  return (
    <button
      className={cn(
        'flex w-full items-center justify-between px-4 py-3 text-left font-medium transition-all hover:bg-muted/50',
        className
      )}
      onClick={handleClick}
      aria-expanded={isOpen}
      // Collapsed content is not rendered, so there is nothing to point at then.
      aria-controls={isOpen ? contentId : undefined}
    >
      {children}
      <ChevronDown
        className={cn(
          'h-4 w-4 shrink-0 transition-transform duration-200',
          isOpen && 'rotate-180'
        )}
      />
    </button>
  );
}

interface AccordionContentProps {
  children: React.ReactNode;
  className?: string;
  isOpen?: boolean;
  contentId?: string;
}

/**
 * Open content renders at its full height — no max-height clip, so a long group
 * is never cut off (F0-8). Collapsed content is not rendered at all, so nothing
 * hidden stays focusable.
 */
export function AccordionContent({ 
  children, 
  className,
  isOpen = false,
  contentId,
}: AccordionContentProps) {
  if (!isOpen) return null;
  return (
    <div id={contentId}>
      <div className={cn('px-4 pb-4', className)}>
        {children}
      </div>
    </div>
  );
}
