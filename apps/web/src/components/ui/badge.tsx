import * as React from 'react';

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export function Badge({ className = '', ...props }: DivProps) {
  return <div className={className} {...props} />;
}