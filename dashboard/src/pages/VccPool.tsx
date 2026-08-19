import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Field } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { SkeletonCard } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  CreditCard,
  Trash2,
  Upload,
  CheckCircle,
  Wand2,
  Copy,
  Download,
  TrendingUp,
  History,
} from "lucide-react";
import { fetchApi } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { VisualCard } from "@/components/vcc/VisualCard";
import { ExportDialog } from "@/components/vcc/ExportDialog";
import { BinSelector } from "@/components/vcc/BinSelector";
import {
  generateVCCs,
  detectBrand,
  formatCardNumber,
  formatExpiry,
  parseCardLines,
  type GeneratedCard,
} from "@/lib/vcc-utils";
import type { BinEntry } from "@/lib/bin-data";

interface VCCCardInfo {
  id: number;
  last4: string;
  exp: string;
  name: string;
  status: string;
}

interface VCCPoolStatus {
  count: number;
  cards: VCCCardInfo[];
}

interface VCCTransaction {
  id: number;
  accountId: number;
  cardLast4: string;
  cardBrand: string;
  status: string;
  createdAt: string;
  email: string | null;
}

export default function VccPool() {
  const [pool, setPool] = useState<VCCPoolStatus>({ count: 0, cards: [] });
  const [transactions, setTransactions] = useState<VCCTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  // Generator state
  const [selectedBin, setSelectedBin] = useState("");
  const [binInfo, setBinInfo] = useState<BinEntry | null>(null);
  const [genCount, setGenCount] = useState(10);
  const [generatedCards, setGeneratedCards] = useState<GeneratedCard[]>([]);
  const [generating, setGenerating] = useState(false);

  // Import state
  const [bulkText, setBulkText] = useState("");

  // Export state
  const [exportOpen, setExportOpen] = useState(false);
  const [exportCards, setExportCards] = useState<GeneratedCard[]>([]);

  const toast = useToast();

  const loadPool = useCallback(async () => {
    try {
      const data = await fetchApi<VCCPoolStatus>("/api/vcc/pool");
      setPool(data);
    } catch {
      setPool({ count: 0, cards: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const data = await fetchApi<{ transactions: VCCTransaction[] }>(
        "/api/vcc/transactions"
      );
      setTransactions(data.transactions || []);
    } catch {
      setTransactions([]);
    }
  }, []);

  useEffect(() => {
    loadPool();
    loadTransactions();
  }, [loadPool, loadTransactions]);

  // Stats
  const stats = useMemo(() => {
    const brandCounts: Record<string, number> = {};
    pool.cards.forEach((card) => {
      const brand = detectBrand(card.last4);
      brandCounts[brand] = (brandCounts[brand] || 0) + 1;
    });
    return {
      total: pool.count,
      visa: brandCounts.visa || 0,
      mastercard: brandCounts.mastercard || 0,
      amex: brandCounts.amex || 0,
      other: (brandCounts.discover || 0) + (brandCounts.unknown || 0),
    };
  }, [pool]);

  // Generator
  const handleBinChange = (bin: string) => {
    setSelectedBin(bin);
  };

  const handleBinInfo = (info: BinEntry | null) => {
    setBinInfo(info);
  };

  const handleGenerate = async () => {
    if (!selectedBin || selectedBin.length < 6) {
      toast.warning("Please select or enter a BIN (minimum 6 digits)");
      return;
    }

    setGenerating(true);
    try {
      // Generate cards with BIN info for better metadata
      const cards = generateVCCs(selectedBin, genCount);

      // Attach BIN info to each card
      const cardsWithInfo = cards.map(card => ({
        ...card,
        binInfo: binInfo || undefined
      }));

      setGeneratedCards(cardsWithInfo);
      toast.success(`Generated ${cardsWithInfo.length} cards`);
    } catch (error) {
      toast.error("Failed to generate cards");
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyCard = async (card: GeneratedCard) => {
    const text = `${card.number}|${formatExpiry(card.expMonth, card.expYear)}|${card.cvv}`;
    await copyText(text);
    toast.success("Card copied");
  };

  const handleCopyAll = async () => {
    const text = generatedCards
      .map((c) => `${c.number}|${formatExpiry(c.expMonth, c.expYear)}|${c.cvv}`)
      .join("\n");
    await copyText(text);
    toast.success(`${generatedCards.length} cards copied`);
  };

  const handleExportGenerated = () => {
    setExportCards(generatedCards);
    setExportOpen(true);
  };

  // Import
  const handleBulkImport = async () => {
    if (!bulkText.trim()) {
      toast.warning("Paste card list first");
      return;
    }

    const cards = parseCardLines(bulkText);

    if (cards.length === 0) {
      toast.warning("No valid cards found");
      return;
    }

    try {
      const formattedCards = cards.map((card) => ({
        number: card.number,
        expMonth: card.month,
        expYear: card.year.length === 2 ? `20${card.year}` : card.year,
        cvv: card.cvv,
        name: "John Doe",
      }));

      const result = await fetchApi<{ added: number }>("/api/vcc/pool", {
        method: "POST",
        body: JSON.stringify({ cards: formattedCards }),
      });
      setBulkText("");
      toast.success(`${result.added} cards imported`);
      loadPool();
    } catch (e: any) {
      toast.error(e.message || "Import failed");
    }
  };

  // Pool management
  const handleDelete = async (id: number) => {
    try {
      await fetchApi(`/api/vcc/pool/${id}`, { method: "DELETE" });
      toast.success("Card removed");
      loadPool();
    } catch (e: any) {
      toast.error(e.message || "Failed to remove card");
    }
  };

  const handleClearAll = async () => {
    if (!confirm("Remove all active VCC cards from pool?")) return;
    try {
      await fetchApi("/api/vcc/pool", { method: "DELETE" });
      toast.success("Pool cleared");
      loadPool();
    } catch (e: any) {
      toast.error(e.message || "Failed to clear pool");
    }
  };

  const handleExportPool = () => {
    const cards: GeneratedCard[] = pool.cards.map((c) => ({
      bin: "",
      number: `****${c.last4}`,
      expMonth: c.exp.split("/")[0] || "",
      expYear: `20${c.exp.split("/")[1] || ""}`,
      cvv: "***",
      brand: detectBrand(c.last4),
    }));
    setExportCards(cards);
    setExportOpen(true);
  };

  const poolColumns: Column<VCCCardInfo>[] = [
    {
      key: "number",
      header: "Card",
      primary: true,
      sortValue: (c) => c.last4,
      cell: (c) => (
        <div className="flex min-w-0 items-center gap-2">
          <CreditCard className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
          <span className="tabular truncate font-mono text-sm text-[var(--foreground)]">
            •••• •••• •••• {c.last4}
          </span>
        </div>
      ),
    },
    {
      key: "brand",
      header: "Brand",
      width: "w-[120px]",
      hideBelow: "md",
      sortValue: (c) => detectBrand(c.last4),
      cell: (c) => (
        <Badge variant="muted" className="font-normal capitalize">
          {detectBrand(c.last4)}
        </Badge>
      ),
    },
    {
      key: "exp",
      header: "Expiry",
      width: "w-[100px]",
      sortValue: (c) => c.exp,
      cell: (c) => (
        <span className="tabular font-mono text-xs text-[var(--muted-foreground)]">{c.exp}</span>
      ),
    },
    {
      key: "name",
      header: "Holder",
      hideBelow: "lg",
      sortValue: (c) => c.name,
      cell: (c) => (
        <span className="block max-w-[200px] truncate text-xs text-[var(--muted-foreground)]">
          {c.name}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[100px]",
      hideBelow: "xl",
      sortValue: (c) => c.status,
      cell: (c) => (
        <Badge variant={c.status === "active" ? "success" : "muted"} dot>
          {c.status}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "w-[70px]",
      cell: (c) => (
        <div className="flex justify-end">
          <Button
            variant="danger"
            size="icon"
            aria-label={`Remove card ending ${c.last4}`}
            title="Remove card"
            onClick={() => handleDelete(c.id)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  const txColumns: Column<VCCTransaction>[] = [
    {
      key: "status",
      header: "Status",
      width: "w-[110px]",
      sortValue: (t) => t.status,
      cell: (t) => (
        <Badge variant={t.status === "success" ? "success" : "error"} dot>
          {t.status}
        </Badge>
      ),
    },
    {
      key: "card",
      header: "Card",
      width: "w-[110px]",
      sortValue: (t) => t.cardLast4,
      cell: (t) => (
        <span className="tabular font-mono text-sm text-[var(--foreground)]">
          •••• {t.cardLast4}
        </span>
      ),
    },
    {
      key: "brand",
      header: "Brand",
      hideBelow: "lg",
      width: "w-[110px]",
      sortValue: (t) => t.cardBrand,
      cell: (t) => (
        <span className="text-xs capitalize text-[var(--muted-foreground)]">{t.cardBrand}</span>
      ),
    },
    {
      key: "account",
      header: "Account",
      primary: true,
      sortValue: (t) => t.email ?? t.accountId,
      cell: (t) => (
        <span className="block max-w-[240px] truncate text-sm text-[var(--foreground)]">
          {t.email || `Account #${t.accountId}`}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "When",
      align: "right",
      hideBelow: "md",
      sortValue: (t) => t.createdAt,
      cell: (t) => (
        <span className="tabular text-xs text-[var(--muted-foreground)]">
          {new Date(t.createdAt).toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <PageShell>
      <PageHeader
        title="VCC Pool"
        description="Generate and manage virtual credit cards with real-time BIN lookup"
        badge={
          <Badge variant="muted" className="tabular">
            {pool.count} active card{pool.count !== 1 ? "s" : ""}
          </Badge>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {loading && pool.cards.length === 0 ? (
          Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <StatCard label="Total" value={stats.total} icon={TrendingUp} tone="primary" />
            <StatCard label="Visa" value={stats.visa} icon={CreditCard} tone="info" />
            <StatCard
              label="Mastercard"
              value={stats.mastercard}
              icon={CreditCard}
              tone="warning"
            />
            <StatCard label="Amex" value={stats.amex} icon={CreditCard} tone="success" />
            <StatCard
              label="Other"
              value={stats.other}
              icon={CreditCard}
              className="col-span-2 lg:col-span-1"
            />
          </>
        )}
      </div>

      <Tabs defaultValue="generator" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="generator">Generator</TabsTrigger>
          <TabsTrigger value="generated">
            Generated {generatedCards.length > 0 && `(${generatedCards.length})`}
          </TabsTrigger>
          <TabsTrigger value="pool">Pool ({pool.count})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {/* Generator Tab */}
        <TabsContent value="generator">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wand2 className="h-4 w-4" />
                  Generate VCC
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <BinSelector
                  value={selectedBin}
                  onChange={handleBinChange}
                  onBinInfo={handleBinInfo}
                />

                <Field label="Number of Cards" htmlFor="gen-count" hint="1–100 per batch.">
                  <Input
                    id="gen-count"
                    type="number"
                    className="tabular"
                    value={genCount}
                    onChange={(e) => setGenCount(parseInt(e.target.value) || 1)}
                    min={1}
                    max={100}
                  />
                </Field>

                <Button onClick={handleGenerate} className="w-full" loading={generating}>
                  {!generating && <Wand2 className="h-4 w-4" />}
                  {generating ? "Generating..." : `Generate ${genCount} Cards`}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Preview</CardTitle>
              </CardHeader>
              <CardContent>
                <VisualCard
                  number={selectedBin.padEnd(16, "0")}
                  expMonth="12"
                  expYear="2030"
                  name={binInfo?.issuer || "CARDHOLDER NAME"}
                  brand={detectBrand(selectedBin)}
                />
                {binInfo && (
                  <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1">
                    <div className="flex items-baseline justify-between gap-4 py-1.5">
                      <span className="text-xs text-[var(--muted-foreground)]">Brand</span>
                      <span className="text-xs font-medium capitalize text-[var(--foreground)]">
                        {binInfo.brand}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 py-1.5">
                      <span className="text-xs text-[var(--muted-foreground)]">Country</span>
                      <span className="text-xs font-medium text-[var(--foreground)]">
                        {binInfo.countryName}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 py-1.5">
                      <span className="text-xs text-[var(--muted-foreground)]">Bank</span>
                      <span className="min-w-0 truncate text-xs font-medium text-[var(--foreground)]">
                        {binInfo.issuer || "Unknown"}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 py-1.5">
                      <span className="text-xs text-[var(--muted-foreground)]">Type</span>
                      <span className="text-xs font-medium capitalize text-[var(--foreground)]">
                        {binInfo.type}
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Generated Cards Tab */}
        <TabsContent value="generated">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Generated Cards</CardTitle>
                {generatedCards.length > 0 && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={handleCopyAll}>
                      <Copy className="h-4 w-4" />
                      Copy All
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleExportGenerated}>
                      <Download className="h-4 w-4" />
                      Export
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {generatedCards.length === 0 ? (
                <EmptyState
                  icon={Wand2}
                  title="No cards generated yet"
                  description="Go to the Generator tab to create cards from a BIN."
                />
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {generatedCards.map((card, idx) => (
                    <div key={idx} className="space-y-2">
                      <VisualCard
                        number={card.number}
                        exp={formatExpiry(card.expMonth, card.expYear)}
                        name={card.binInfo?.issuer || "CARDHOLDER NAME"}
                        brand={card.brand || detectBrand(card.number)}
                        showActions
                        onCopy={() => handleCopyCard(card)}
                      />
                      <div className="tabular px-1 font-mono text-xs text-[var(--muted-foreground)]">
                        <div>{formatCardNumber(card.number)}</div>
                        <div className="mt-1 flex justify-between">
                          <span>Exp: {formatExpiry(card.expMonth, card.expYear)}</span>
                          <span>CVV: {card.cvv}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Pool Tab */}
        <TabsContent value="pool" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Upload className="h-4 w-4" />
                Import Cards
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field
                label="Card list"
                htmlFor="vcc-bulk"
                hint="One per line: number|mm/yy|cvv or number|mm|yy|cvv"
              >
                <Textarea
                  id="vcc-bulk"
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={
                    "4111111111111111|12/30|123\n4111111111111111|12|30|123"
                  }
                  className="h-[120px] resize-none font-mono"
                />
              </Field>
              <Button onClick={handleBulkImport} className="w-full">
                <Upload className="h-4 w-4" />
                Import Cards
              </Button>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-[var(--muted-foreground)]" />
              <h2 className="text-sm font-semibold text-[var(--foreground)]">
                Active Cards in Pool
              </h2>
              <Badge variant="muted" className="tabular">
                {pool.count}
              </Badge>
            </div>
            {pool.count > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={handleExportPool}>
                  <Download className="h-4 w-4" />
                  Export
                </Button>
                <Button variant="danger" size="sm" onClick={handleClearAll}>
                  <Trash2 className="h-4 w-4" />
                  Clear All
                </Button>
              </div>
            )}
          </div>

          <DataTable
            columns={poolColumns}
            rows={pool.cards}
            rowKey={(c) => c.id}
            loading={loading && pool.cards.length === 0}
            pageSize={25}
            empty={
              <EmptyState
                compact
                icon={CreditCard}
                title="No active cards in pool"
                description="Generate or import cards above to fill the pool."
              />
            }
          />
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history">
          <DataTable
            columns={txColumns}
            rows={transactions}
            rowKey={(t) => t.id}
            pageSize={25}
            empty={
              <EmptyState
                compact
                icon={History}
                title="No upgrade transactions yet"
                description="Successful and failed card upgrades will be listed here."
              />
            }
          />
        </TabsContent>
      </Tabs>

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        cards={exportCards}
        onMessage={(m) => toast.info(m)}
      />
    </PageShell>
  );
}
