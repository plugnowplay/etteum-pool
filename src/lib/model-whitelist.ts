/**
 * Model whitelist matching — single source of truth.
 *
 * Dipakai oleh dua tempat yang HARUS sepakat:
 *   - src/index.ts    → enforcement (nolak request model yang gak diizinkan)
 *   - src/api/share.ts → listing (model apa yang ditampilkan di share page)
 *
 * Kalau keduanya beda, share page bisa mengiklankan model yang justru ditolak
 * proxy (atau sebaliknya) — persis bug yang bikin util ini dibuat.
 *
 * ## Kenapa bukan `includes()`?
 *
 * Implementasi lama pakai `modelId.includes(entry)`, jadi whitelist "me" cocok
 * dengan "grok-4.6-medium" karena substring "me" nyangkut di tengah kata
 * "medium". Match di tengah kata itu selalu kecelakaan, bukan maksud user.
 *
 * ## Aturan match
 *
 * Model id dipecah jadi token pada batas `/`, `-`, `.`, `:`, `_`, lalu entry
 * whitelist harus cocok dengan *deretan token berurutan*. Ini membuang match
 * di tengah kata tapi tetap menjaga gaya prefix yang berguna:
 *
 *   "grok-4.6-medium" → cocok "gcli/grok-4.6-medium"   (persis)
 *   "glm"             → cocok "cb/glm-5.3"             (satu token penuh)
 *   "claude-sonnet-4" → cocok "claude-sonnet-4.5"      (deretan token)
 *   "me"              → GAK cocok "grok-4.6-medium"    (bukan token utuh)
 *
 * Butuh yang lebih longgar? Pakai glob eksplisit: `grok*`, `*medium`, `*4.6*`.
 */

/** Karakter pemisah token di dalam sebuah model id. */
const TOKEN_SEPARATORS = /[/\-.:_\s]+/;

/** Pecah model id / entry whitelist jadi token yang sudah dinormalisasi. */
function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .trim()
    .split(TOKEN_SEPARATORS)
    .filter((t) => t.length > 0);
}

/** Ubah entry ber-glob (`grok*`, `*medium`) jadi RegExp yang ter-anchor. */
function globToRegExp(entry: string): RegExp {
  const escaped = entry
    .toLowerCase()
    .trim()
    // Escape semua metakarakter regex KECUALI `*` yang kita tangani sendiri.
    .replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "\0" : `\\${ch}`))
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Apakah `needle` muncul sebagai deretan token berurutan di `haystack`? */
function hasTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Normalisasi string whitelist mentah dari DB (`"glm-5.3, gpt-4o"`) jadi
 * array entry lowercase. Kosong = izinkan semua.
 */
export function parseModelWhitelist(raw: string | null | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Apakah `modelId` diizinkan oleh `whitelist`?
 * Whitelist kosong = izinkan semua (konsisten dengan perilaku lama).
 *
 * @param modelId   id model, boleh pakai prefix provider (`gcli/grok-4.6-medium`)
 * @param whitelist hasil {@link parseModelWhitelist}
 */
export function isModelAllowed(modelId: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;

  const id = String(modelId || "").toLowerCase().trim();
  if (!id) return false;

  // Bandingkan terhadap id lengkap DAN nama tanpa prefix provider, biar entry
  // "glm-5.2" tetap cocok dengan "cb/glm-5.2" dan sebaliknya.
  const bare = id.includes("/") ? id.split("/").pop()! : id;
  const idTokens = tokenize(id);
  const bareTokens = tokenize(bare);

  return whitelist.some((entry) => {
    // Entry boleh ikut bawa prefix provider ("cb/glm-5.2"); bandingkan versi
    // telanjangnya juga supaya arah mana pun tetap cocok.
    const bareEntry = entry.includes("/") ? entry.split("/").pop()! : entry;

    if (entry.includes("*")) {
      const re = globToRegExp(entry);
      if (re.test(id) || re.test(bare)) return true;
      // Glob tanpa prefix provider: "grok*" harus cocok "gcli/grok-4.6".
      return globToRegExp(bareEntry).test(bare);
    }

    const entryTokens = tokenize(entry);
    if (hasTokenRun(idTokens, entryTokens) || hasTokenRun(bareTokens, entryTokens)) return true;

    const bareEntryTokens = tokenize(bareEntry);
    return hasTokenRun(idTokens, bareEntryTokens) || hasTokenRun(bareTokens, bareEntryTokens);
  });
}
