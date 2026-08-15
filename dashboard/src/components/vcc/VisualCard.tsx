import { cn } from '@/lib/utils';
import { getBrandGradient, getBrandName, formatCardNumber, formatExpiry } from '@/lib/vcc-utils';
import { Copy, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';

interface VisualCardProps {
  number?: string;
  last4?: string;
  exp?: string;
  expMonth?: string;
  expYear?: string;
  name?: string;
  brand?: string;
  className?: string;
  onCopy?: () => void;
  onDelete?: () => void;
  showActions?: boolean;
}

// Brand logo SVGs
function BrandLogo({ brand }: { brand: string }): ReactNode {
  const logos: Record<string, ReactNode> = {
    visa: (
      <svg viewBox="0 0 100 40" className="h-8 fill-white">
        <path d="M40 32h-7l4-24h7l-4 24zm28-23l-3 15-4-2c-1-.5-2-.8-3-.8-3 0-5 1-5 3 0 1 1 2 2 2h5c4 0 6 2 6 5 0 5-4 8-10 8-3 0-6-1-8-2l1-3c2 1 4 2 7 2 3 0 5-1 5-3s-2-2-5-2h-4c-2 0-3-1-3-3 0-4 4-8 10-8 2 0 4 0 5 1l-1-4zm-30 1c2 0 3 1 3 1l1-4s-2-1-5-1c-5 0-8 3-8 6 0 3 2 4 5 6 2 1 3 2 3 3 0 2-2 3-4 3-2 0-4-1-5-1l-1 4c2 1 4 2 7 2 5 0 8-3 8-7 0-2-1-4-4-5-2-1-3-2-3-3 0-2 2-3 4-3zm50-1l-6 15-1-7c0-2-1-3-2-4l-3 11h-7l6-24h6l0 12 5-12h2z" />
      </svg>
    ),
    mastercard: (
      <div className="flex items-center h-8">
        <div className="w-8 h-8 rounded-full bg-red-500" />
        <div className="w-8 h-8 rounded-full bg-orange-500 -ml-3 opacity-80" />
      </div>
    ),
    amex: (
      <div className="text-white font-bold text-lg tracking-wider">
        AMERICAN<br />EXPRESS
      </div>
    ),
    discover: (
      <div className="text-white font-bold text-xl">
        DISCOVER
      </div>
    ),
    jcb: (
      <div className="flex gap-1 h-8">
        <div className="w-6 bg-blue-500 rounded flex items-center justify-center text-white font-bold text-xs">J</div>
        <div className="w-6 bg-red-500 rounded flex items-center justify-center text-white font-bold text-xs">C</div>
        <div className="w-6 bg-green-500 rounded flex items-center justify-center text-white font-bold text-xs">B</div>
      </div>
    ),
    unionpay: (
      <div className="text-white font-bold text-lg">
        UnionPay
      </div>
    ),
    diners: (
      <div className="text-white font-bold text-lg">
        DINERS
      </div>
    ),
  };

  return logos[brand] || <div className="text-white font-bold text-lg">CARD</div>;
}

export function VisualCard({
  number,
  last4,
  exp,
  expMonth,
  expYear,
  name = 'CARDHOLDER NAME',
  brand = 'unknown',
  className,
  onCopy,
  onDelete,
  showActions = false,
}: VisualCardProps) {
  const gradient = getBrandGradient(brand);
  const displayNumber = number
    ? formatCardNumber(number)
    : last4
    ? `•••• •••• •••• ${last4}`
    : '•••• •••• •••• ••••';
  const displayExp = exp || formatExpiry(expMonth || '01', expYear || '2030');

  return (
    <div
      className={cn(
        'group relative aspect-[1.586/1] w-full overflow-hidden rounded-xl',
        'shadow-[var(--es-3)] transition-all duration-[var(--dur-base)] ease-[var(--ease-out)]',
        'hover:-translate-y-0.5 hover:shadow-[var(--es-4)]',
        className
      )}
    >
      {/* Gradient background */}
      <div className={cn('absolute inset-0 bg-gradient-to-br', gradient)} />

      {/* Decorative circles */}
      <div className="absolute -right-20 -top-20 h-60 w-60 rounded-full bg-white/5" />
      <div className="absolute -bottom-32 -left-32 h-80 w-80 rounded-full bg-white/5" />
      {/* Sheen sweep on hover */}
      <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-[600ms] ease-[var(--ease-out)] group-hover:translate-x-full" />

      {/* Content */}
      <div className="relative flex h-full flex-col justify-between p-5 text-white md:p-6">
        {/* Top: EMV chip + brand logo */}
        <div className="flex items-start justify-between">
          <div className="h-7 w-9 rounded-[4px] bg-gradient-to-br from-[#e8d48b] to-[#b8912f] shadow-inner">
            <div className="mx-auto mt-1 h-5 w-6 rounded-[2px] border border-black/15" />
          </div>
          <BrandLogo brand={brand} />
        </div>

        {/* Middle: Card number */}
        <div className="tabular select-all font-mono text-xl tracking-[0.12em] drop-shadow-sm md:text-2xl">
          {displayNumber}
        </div>

        {/* Bottom: Name and expiry */}
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-white/60">
              Card Holder
            </div>
            <div className="truncate text-sm font-medium uppercase tracking-wider md:text-base">
              {name}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-white/60">
              Expires
            </div>
            <div className="tabular font-mono text-sm md:text-base">{displayExp}</div>
          </div>
        </div>
      </div>

      {/* Action buttons overlay */}
      {showActions && (onCopy || onDelete) && (
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity duration-[var(--dur-fast)] focus-within:opacity-100 group-hover:opacity-100">
          {onCopy && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onCopy}
              aria-label="Copy card number"
              className="h-8 w-8 min-h-0 min-w-0 bg-black/35 text-white backdrop-blur-sm hover:bg-black/55 hover:text-white"
            >
              <Copy className="h-4 w-4" />
            </Button>
          )}
          {onDelete && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onDelete}
              aria-label="Delete card"
              className="h-8 w-8 min-h-0 min-w-0 bg-black/35 text-white backdrop-blur-sm hover:bg-[var(--destructive)]/80 hover:text-white"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
