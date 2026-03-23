import * as React from 'react';

type DivProps = React.HTMLAttributes<HTMLDivElement>;

interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  children?: React.ReactNode;
}

const SelectContext = React.createContext<{
  value?: string;
  onValueChange?: (value: string) => void;
} | null>(null);

export function Select({ value, onValueChange, children }: SelectProps) {
  return (
    <SelectContext.Provider value={{ value, onValueChange }}>
      {children}
    </SelectContext.Provider>
  );
}

export function SelectTrigger({ className = '', ...props }: DivProps) {
  return <div className={className} {...props} />;
}

export function SelectValue({
  placeholder,
}: {
  placeholder?: React.ReactNode;
}) {
  const context = React.useContext(SelectContext);
  return <span>{context?.value ?? placeholder ?? null}</span>;
}

export function SelectContent({ className = '', ...props }: DivProps) {
  return <div className={className} {...props} />;
}

export function SelectItem({
  value,
  className = '',
  children,
  ...props
}: DivProps & { value: string }) {
  const context = React.useContext(SelectContext);

  return (
    <div
      className={className}
      onClick={() => context?.onValueChange?.(value)}
      {...props}
    >
      {children}
    </div>
  );
}