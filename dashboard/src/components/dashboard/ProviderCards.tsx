import { Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/ui/empty-state";

interface ProviderData {
  name: string;
  color: string;
  bgColor: string;
  accounts: { active: number; exhausted: number; error: number; total: number };
  credits: { used: number; total: number; remaining?: number };
}

interface ProviderCardsProps {
  providers?: ProviderData[];
}

const defaultProviders: ProviderData[] = [];

export default function ProviderCards({ providers = defaultProviders }: ProviderCardsProps) {
  if (providers.length === 0) {
    return (
      <Card>
        <EmptyState
          compact
          icon={Inbox}
          title="No provider data yet"
          description="Add or log in accounts to populate this section."
        />
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {providers.map((provider) => {
        const usedPercentage =
          provider.credits.total > 0
            ? Math.round((provider.credits.used / provider.credits.total) * 100)
            : 0;
        const remaining =
          provider.credits.remaining ?? provider.credits.total - provider.credits.used;

        // Near-exhaustion should read as a warning even before it hits zero.
        const barTone =
          usedPercentage >= 90
            ? "var(--error)"
            : usedPercentage >= 70
              ? "var(--warning)"
              : provider.color;

        return (
          <Card
            key={provider.name}
            className="transition-all duration-[var(--dur-base)] ease-[var(--ease-out)] hover:-translate-y-0.5 hover:shadow-[var(--es-3)]"
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: provider.color,
                      boxShadow: `0 0 8px ${provider.color}`,
                    }}
                  />
                  <CardTitle className="truncate">{provider.name}</CardTitle>
                </div>
                <span className="tabular shrink-0 text-xs text-[var(--muted-foreground)]">
                  {provider.accounts.active}/{provider.accounts.total}
                </span>
              </div>
            </CardHeader>

            <CardContent className="space-y-3.5">
              <div className="flex flex-wrap gap-1.5">
                {provider.accounts.active > 0 && (
                  <Badge variant="success" dot className="tabular font-normal">
                    {provider.accounts.active} active
                  </Badge>
                )}
                {provider.accounts.exhausted > 0 && (
                  <Badge variant="warning" dot className="tabular font-normal">
                    {provider.accounts.exhausted} exhausted
                  </Badge>
                )}
                {provider.accounts.error > 0 && (
                  <Badge variant="error" dot className="tabular font-normal">
                    {provider.accounts.error} error
                  </Badge>
                )}
                {provider.accounts.total === 0 && (
                  <Badge variant="muted" className="font-normal">
                    no accounts
                  </Badge>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-[var(--muted-foreground)]">Credits</span>
                  <span className="tabular text-[var(--foreground)]">
                    {provider.credits.used.toFixed(2)}
                    <span className="text-[var(--muted-foreground)]">
                      {" / "}
                      {provider.credits.total.toFixed(2)}
                    </span>
                  </span>
                </div>
                <Progress
                  value={usedPercentage}
                  indicatorClassName="rounded-full bg-[var(--progress-color)] transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
                  style={{ ["--progress-color" as string]: barTone } as React.CSSProperties}
                  className="h-1.5"
                />
                <div className="tabular flex justify-between text-[11px] text-[var(--muted-foreground)]">
                  <span>{usedPercentage}% used</span>
                  <span>{remaining.toFixed(2)} left</span>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
