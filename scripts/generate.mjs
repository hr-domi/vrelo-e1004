import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';

// =========================================================================
// ZADANI IZGLED (možeš mijenjati ovdje ILI napraviti datoteku style.json
// u glavnoj mapi repozitorija — generira je gumb u HTML editoru v1.5!)
// =========================================================================
const DEFAULT_STYLE = {
  serifFont: 'Lora',        // Google Font za naslov, sažetak i citat (Lora, Merriweather, EB Garamond, Playfair Display, PT Serif...)
  sansFont: 'Inter',        // Google Font za datum, dan i misao (Inter, Roboto, Open Sans, Montserrat...)
  artHeightPortrait: 610,   // Visina ilustracije u portretu (px); manje = više mjesta za veća slova
  dateSize: 38,             // Veličina datuma i dana (px)
  metaSize: 26,             // Veličina reference i liturgijskog dana (px)
  titleSize: 64,            // Veličina naslova (px)
  summarySize: 40,          // Veličina sažetka (px)
  verseSize: 38,            // Veličina ključnog retka (px)
  reflectionSize: 29,       // Veličina misli dana (px)
  showReflection: true,     // true = prikaži misao dana, false = sakrij
};

function loadStyleConfig() {
  const stylePath = path.resolve(process.cwd(), 'style.json');
  if (!fs.existsSync(stylePath)) return { ...DEFAULT_STYLE };
  try {
    const custom = JSON.parse(fs.readFileSync(stylePath, 'utf8'));
    console.log('Učitan prilagođeni izgled iz style.json');
    return { ...DEFAULT_STYLE, ...custom };
  } catch (e) {
    console.warn('Neispravan style.json, koristim zadani izgled:', e.message);
    return { ...DEFAULT_STYLE };
  }
}

const CROATIAN_WEEKDAY_SLUGS = [
  'nedjelja', 'ponedjeljak', 'utorak', 'srijeda', 'cetvrtak', 'petak', 'subota',
];
const CROATIAN_WEEKDAYS = [
  'Nedjelja', 'Ponedjeljak', 'Utorak', 'Srijeda', 'Četvrtak', 'Petak', 'Subota',
];
const CROATIAN_MONTHS_GEN = [
  'siječnja', 'veljače', 'ožujka', 'travnja', 'svibnja', 'lipnja',
  'srpnja', 'kolovoza', 'rujna', 'listopada', 'studenoga', 'prosinca',
];

function getZagrebDateIso() {
  const override = (process.env.DATE_OVERRIDE || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zagreb' }).format(new Date());
}

function formatCroatianDate(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return `${CROATIAN_WEEKDAYS[utc.getUTCDay()]}, ${d}. ${CROATIAN_MONTHS_GEN[m - 1]} ${y}.`;
}

function decodeHtmlEntities(input) {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rdquo;/gi, '”')
    .replace(/&ldquo;/gi, '“')
    .replace(/&bdquo;/gi, '„')
    .replace(/&raquo;/gi, '»')
    .replace(/&laquo;/gi, '«')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8222;/g, '„')
    .replace(/&#(\d+);/g, (_m, c) => String.fromCharCode(Number(c)));
}

function stripTags(html) {
  return decodeHtmlEntities(
    html.replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

function parseLiturgicalColor(raw) {
  const l = raw.toLowerCase();
  if (l.includes('crven')) return 'crvena';
  if (l.includes('ljubič') || l.includes('ljubic')) return 'ljubičasta';
  if (l.includes('bijel') || l.includes('zlat')) return 'bijela';
  if (l.includes('ružič') || l.includes('ruzic')) return 'ružičasta';
  return 'zelena';
}

function inferSeason(week) {
  const l = week.toLowerCase();
  if (l.includes('došaš') || l.includes('advent')) return 'Došašće';
  if (l.includes('božić')) return 'Božićno vrijeme';
  if (l.includes('korizm') || l.includes('veliki tjedan')) return 'Korizma';
  if (l.includes('uskrs') || l.includes('vazmen')) return 'Uskrsno vrijeme';
  return 'Vrijeme kroz godinu';
}

async function fetchHilpReading(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const slug = CROATIAN_WEEKDAY_SLUGS[utc.getUTCDay()];
  const urls = [
    `https://hilp.hr/liturgija-dana/${slug}-${d}-${m}-${y}/`,
    `https://hilp.hr/liturgija-dana/${slug}-${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}/`,
  ];

  let html = '';
  let finalUrl = urls[0];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VreloE1004/1.5; +https://hilp.hr)',
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
      });
      if (r.ok) {
        html = await r.text();
        finalUrl = r.url || url;
        break;
      }
    } catch (e) {
      console.warn('HILP fetch pokušaj neuspješan:', url, e.message);
    }
  }
  if (!html) return null;

  const blurbs = [];
  for (const rawChunk of html.split('<div class="et_pb_blurb_container">').slice(1)) {
    const boundary = rawChunk.search(/<div[^>]*class="[^"]*et_pb_(?:module|divider|section|row)/i);
    const seg = boundary !== -1 ? rawChunk.slice(0, boundary) : rawChunk.slice(0, 6000);
    const hM = seg.match(/<h[1-6][^>]*class="[^"]*et_pb_module_header[^"]*"[^>]*>([\s\S]*?)<\/h[1-6]>/i);
    const dM = seg.match(/<div[^>]*class="[^"]*et_pb_blurb_description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const header = hM ? stripTags(hM[1]) : '';
    const desc = dM ? stripTags(dM[1]) : '';
    if (header || desc) blurbs.push({ header, desc });
  }
  if (!blurbs.length) return null;

  let thoughtOfTheDay = '', liturgicalRank = '', liturgicalWeek = '', allReferences = '';
  let liturgicalColor = 'zelena', nameDays = '', gospelRef = '', gospelHeadline = '', gospelText = '';

  for (let i = 0; i < blurbs.length; i++) {
    const { header, desc } = blurbs[i];
    const hl = header.toLowerCase();
    if (hl.includes('misao iz evanđelja')) thoughtOfTheDay = desc;
    else if (hl.startsWith('misna čitanja')) allReferences = desc;
    else if (hl.startsWith('boja liturgijskog ruha')) liturgicalColor = parseLiturgicalColor(desc);
    else if (hl.startsWith('imendani')) nameDays = desc;
    else if (hl.startsWith('evanđelje')) {
      gospelRef = desc;
      if (blurbs[i + 1]?.desc) {
        gospelHeadline = blurbs[i + 1].header;
        gospelText = blurbs[i + 1].desc;
      }
    } else if (!liturgicalWeek && /tjedan|došašć|korizm|uskrs|božić|nedjelja/i.test(header) && !/\d{4}/.test(header)) {
      liturgicalWeek = header;
    } else if (!liturgicalRank && i >= 1 && i <= 4 && !desc && !/\d{4}/.test(header) && header.length > 2) {
      liturgicalRank = header;
    }
  }

  const cleanedGospel = gospelText
    .replace(/^Čitanje svetog Evanđelja po [^\n]+\n?/i, '')
    .replace(/\n?Riječ Gospodnja\.?\s*$/i, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    date: dateIso,
    url: finalUrl,
    thoughtOfTheDay,
    liturgicalRank,
    liturgicalWeek,
    liturgicalSeason: inferSeason(liturgicalWeek || liturgicalRank),
    liturgicalColor,
    nameDays,
    allReferences,
    gospelRef,
    gospelHeadline,
    gospelText: cleanedGospel || gospelText,
  };
}

function extractJsonObject(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const DEFAULT_IMG_PROMPT =
  'Timeless sacred Renaissance woodblock and oil illustration of warm golden light streaming into a peaceful stone chapel with an olive branch and open scripture, rich crimson, ultramarine blue, ochre yellow, deep green, ivory parchment, no text, no letters.';

async function generateSummaryWithAI(hilp, displayDateHr) {
  const prompt = [
    'Ti si vrhunski lektor i urednik hrvatskog katoličkog liturgijskog kalendara.',
    'PIŠI ISKLJUČIVO BESPRIJEKORNIM STANDARDNIM HRVATSKIM KNJIŽEVNIM JEZIKOM.',
    'STROGA JEZIČNA PRAVILA:',
    '- Provjeri svaku rečenicu na točne padeže, rod, broj i glagolske oblike (npr. „neka naša srca budu”, nikako „neka bude naša srca”; „njegov nauk”, nikako „njegovim naukama”).',
    '- Izbjegavaj tuđice i engleske kalkove (nikad „zaintrigirani”, „fokusirani” i sl. — koristi prirodne hrvatske riječi: „pozorno slušaju”, „okupljeni”, „poučava”).',
    '- Polje "keyVerse" PREPIŠI DOSLOVNO iz priloženog hrvatskog teksta evanđelja ili misli dana (ne izmišljaj svoj prijevod!).',
    '',
    'Vrati ISKLJUČIVO valjani JSON objekt (bez dodatnog teksta) s ovim poljima:',
    '- "title": kratak, snažan naslov na hrvatskom (2 do 5 riječi)',
    '- "shortSummary": sažetak evanđelja u 2 do 3 tečne, tople hrvatske rečenice (ukupno 150 do 220 znakova)',
    '- "keyVerse": jedan kratak, doslovno prepisan redak iz današnjeg evanđelja (bez vanjskih navodnika, do 98 znakova)',
    '- "dailyReflection": jedna kratka, gramatički besprijekorna duhovna misao dana (do 92 znaka)',
    '- "imagePrompt": opis prizora za ilustraciju NA ENGLESKOM (1-2 rečenice) u stilu toplog klasičnog drvoreza / ulja na platnu sa sakralnom simbolikom, BEZ ikakvog teksta, slova ili natpisa na slici, izražajnog kontrasta i čistih tonova (krem, crvena, zlatno-žuta, modra, zelena, tamna tinta).',
    '',
    `Datum: ${displayDateHr}`,
    `Liturgijski dan: ${hilp?.liturgicalWeek || hilp?.liturgicalRank || 'Svagdan'}`,
    `Evanđelje (${hilp?.gospelRef || ''}): ${hilp?.gospelHeadline || ''}`,
    `Misao iz evanđelja (hilp.hr): ${hilp?.thoughtOfTheDay || ''}`,
    `Tekst evanđelja: ${(hilp?.gospelText || '').slice(0, 1800)}`,
  ].join('\n');

  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (geminiKey) {
    const models = [
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite',
    ];
    for (const model of models) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.25,
                responseMimeType: 'application/json',
              },
            }),
          }
        );
        if (!r.ok) {
          const errTxt = (await r.text()).slice(0, 220);
          console.warn(`Gemini ${model} HTTP ${r.status}: ${errTxt}`);
          continue;
        }
        const data = await r.json();
        const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = extractJsonObject(txt);
        if (parsed?.title && parsed?.shortSummary) {
          console.log(`Sažetak generiran putem Gemini (${model})`);
          return parsed;
        }
      } catch (e) {
        console.warn(`Gemini ${model} greška:`, e.message);
      }
    }
  }

  const cfAccount = (process.env.CF_ACCOUNT_ID || '').trim();
  const cfToken = (process.env.CF_API_TOKEN || '').trim();
  if (cfAccount && cfToken) {
    const cfModels = [
      '@cf/google/gemma-3-12b-it',
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    ];
    for (const model of cfModels) {
      try {
        const r = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/ai/run/${model}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cfToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messages: [
                {
                  role: 'system',
                  content:
                    'Ti si lektor hrvatskog književnog jezika. Odgovaraj isključivo čistim JSON objektom na besprijekornom hrvatskom jeziku.',
                },
                { role: 'user', content: prompt },
              ],
            }),
          }
        );
        if (!r.ok) {
          console.warn(`Cloudflare LLM ${model} HTTP ${r.status}`);
          continue;
        }
        const data = await r.json();
        const raw = typeof data?.result?.response === 'string'
          ? data.result.response
          : JSON.stringify(data?.result?.response || '');
        const parsed = extractJsonObject(raw);
        if (parsed?.title && parsed?.shortSummary) {
          console.log(`Sažetak generiran putem Cloudflare (${model})`);
          return parsed;
        }
      } catch (e) {
        console.warn(`Cloudflare LLM ${model} greška:`, e.message);
      }
    }
  }

  console.warn('Koristim izravni sažetak s hilp.hr (AI rezerva)');
  return {
    title: hilp?.gospelHeadline || 'Dnevno evanđelje',
    shortSummary: (hilp?.gospelText || 'Čitanje iz dnevnog evanđelja.').slice(0, 210).replace(/\s+\S*$/, '…'),
    keyVerse: hilp?.thoughtOfTheDay || hilp?.gospelHeadline || 'Riječ Gospodnja.',
    dailyReflection: hilp?.nameDays ? `Imendani: ${hilp.nameDays}` : 'Neka današnja Riječ bude svjetlo tvojem koraku.',
    imagePrompt: DEFAULT_IMG_PROMPT,
  };
}

function buildFallbackSacredSvg(liturgicalColor) {
  const accent = liturgicalColor === 'crvena' || liturgicalColor === 'ružičasta'
    ? '#B02E26'
    : liturgicalColor === 'bijela'
      ? '#C69214'
      : liturgicalColor === 'ljubičasta'
        ? '#214C94'
        : '#2E7442';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1064" height="610" viewBox="0 0 1064 610">
    <rect width="1064" height="610" fill="#F2EDE1"/>
    <rect x="20" y="20" width="1024" height="570" fill="none" stroke="#1C1917" stroke-width="4"/>
    <path d="M182 590 L182 300 A350 350 0 0 1 882 300 L882 590 Z" fill="#214C94" opacity="0.18"/>
    <path d="M232 590 L232 310 A300 300 0 0 1 832 310 L832 590 Z" fill="none" stroke="${accent}" stroke-width="5"/>
    <circle cx="532" cy="252" r="124" fill="#E2BC30" opacity="0.9"/>
    <circle cx="532" cy="252" r="152" fill="none" stroke="#1C1917" stroke-width="3" stroke-dasharray="10 10"/>
    <path d="M120 515 Q340 390 532 455 T944 485 L944 590 L120 590 Z" fill="${accent}"/>
    <path d="M120 555 Q390 455 640 520 T944 535 L944 590 L120 590 Z" fill="#1C1917"/>
    <rect x="516" y="130" width="32" height="255" fill="#1C1917"/>
    <rect x="436" y="208" width="192" height="32" fill="#1C1917"/>
    <rect x="523" y="137" width="18" height="241" fill="#F2EDE1"/>
    <rect x="443" y="215" width="178" height="18" fill="#F2EDE1"/>
  </svg>`;
}

async function generateArtworkBuffer(imagePrompt, liturgicalColor) {
  const cfAccount = (process.env.CF_ACCOUNT_ID || '').trim();
  const cfToken = (process.env.CF_API_TOKEN || '').trim();
  if (cfAccount && cfToken) {
    try {
      const basePrompt = imagePrompt || DEFAULT_IMG_PROMPT;
      const fullPrompt = `${basePrompt}. Painterly sacred woodblock and museum fine-art illustration style, strong composition, luminous daylight, vibrant high-contrast pigments (warm ivory, crimson, golden yellow, ultramarine blue, forest green, deep charcoal ink), absolutely NO text, NO letters, NO words, NO watermark.`;
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: fullPrompt, steps: 6 }),
        }
      );
      if (r.ok) {
        const data = await r.json();
        if (data?.result?.image) {
          console.log('AI ilustracija generirana putem Cloudflare FLUX.1 schnell');
          return Buffer.from(data.result.image, 'base64');
        }
      } else {
        console.warn('Cloudflare FLUX HTTP', r.status, await r.text());
      }
    } catch (e) {
      console.warn('Cloudflare FLUX greška:', e.message);
    }
  }

  console.log('Koristim ugrađenu sakralnu vektorsku ilustraciju');
  const svg = buildFallbackSacredSvg(liturgicalColor);
  return new Resvg(svg, { fitTo: { mode: 'width', value: 1064 }, font: { loadSystemFonts: false } }).render().asPng();
}

const SPECTRA6_PALETTE = [
  { measure: [24, 24, 26], drive: [0, 0, 0] },
  { measure: [240, 237, 230], drive: [255, 255, 255] },
  { measure: [176, 44, 36], drive: [255, 0, 0] },
  { measure: [226, 188, 48], drive: [255, 255, 0] },
  { measure: [34, 76, 152], drive: [0, 0, 255] },
  { measure: [44, 118, 66], drive: [0, 255, 0] },
];

// Točan redoslijed boja iz reTerminal E1004 Arduino firmwarea v1.4:
// PAL[6] = { TFT_BLACK, TFT_WHITE, TFT_YELLOW, TFT_RED, TFT_BLUE, TFT_GREEN };
const E6_DRIVE_RGB = [
  [0, 0, 0],       // 0: crna
  [255, 255, 255], // 1: bijela
  [255, 255, 0],   // 2: žuta
  [255, 0, 0],     // 3: crvena
  [0, 0, 255],     // 4: plava
  [0, 255, 0],     // 5: zelena
];

function nearestSpectra(r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < SPECTRA6_PALETTE.length; i++) {
    const [pr, pg, pb] = SPECTRA6_PALETTE[i].measure;
    const rm = (r + pr) * 0.5, dr = r - pr, dg = g - pg, db = b - pb;
    const d = ((512 + rm) * dr * dr) / 256 + 4 * dg * dg + ((767 - rm) * db * db) / 256;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function applySpectra6Dither(rgba, width, height, useDrive) {
  const buf = new Float32Array(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    buf[i * 3] = rgba[p]; buf[i * 3 + 1] = rgba[p + 1]; buf[i * 3 + 2] = rgba[p + 2];
  }
  const out = Buffer.alloc(width * height * 4);
  const bleed = 0.84;
  for (let y = 0; y < height; y++) {
    const rev = (y & 1) === 1;
    const xStart = rev ? width - 1 : 0, xEnd = rev ? -1 : width, step = rev ? -1 : 1;
    for (let x = xStart; x !== xEnd; x += step) {
      const idx = y * width + x, bi = idx * 3;
      const r = Math.max(0, Math.min(255, buf[bi]));
      const g = Math.max(0, Math.min(255, buf[bi + 1]));
      const b = Math.max(0, Math.min(255, buf[bi + 2]));
      const entry = SPECTRA6_PALETTE[nearestSpectra(r, g, b)];
      const [mr, mg, mb] = entry.measure;
      const [or, og, ob] = useDrive ? entry.drive : entry.measure;
      const oi = idx * 4;
      out[oi] = or; out[oi + 1] = og; out[oi + 2] = ob; out[oi + 3] = 255;
      const er = (r - mr) * bleed, eg = (g - mg) * bleed, eb = (b - mb) * bleed;
      const push = (nx, ny, w) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const ni = (ny * width + nx) * 3;
        buf[ni] += er * w; buf[ni + 1] += eg * w; buf[ni + 2] += eb * w;
      };
      push(x + step, y, 7 / 16);
      push(x - step, y + 1, 3 / 16);
      push(x, y + 1, 5 / 16);
      push(x + step, y + 1, 1 / 16);
    }
  }
  return out;
}

function nearestE6Index(r, g, b) {
  const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
  if (maxC - minC < 24) return r + g + b < 405 ? 0 : 1;
  let best = 1, bestD = Infinity;
  for (let i = 0; i < E6_DRIVE_RGB.length; i++) {
    const [pr, pg, pb] = E6_DRIVE_RGB[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d === 0) return i;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

async function downloadGoogleFonts(fontNames) {
  const tmpDir = '/tmp/vrelo_gfonts';
  fs.mkdirSync(tmpDir, { recursive: true });
  const downloaded = [];
  const unique = [...new Set(fontNames.map((f) => String(f || '').trim()).filter(Boolean))];

  for (const name of unique) {
    if (/^(Liberation|DejaVu|Georgia|Arial|Times|Verdana|Tahoma|Segoe|Courier|Impact|Palatino)/i.test(name)) continue;
    const queries = [
      `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:ital,wght@0,400;0,700;1,400`,
      `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@400;700`,
      `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}`,
    ];
    let css = '';
    for (const q of queries) {
      try {
        const r = await fetch(q, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.ok) { css = await r.text(); break; }
      } catch {}
    }
    const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+\.ttf)\)/g)].map((m) => m[1]))];
    for (let i = 0; i < urls.length; i++) {
      try {
        const r = await fetch(urls[i]);
        if (!r.ok) continue;
        const safe = name.replace(/[^A-Za-z0-9_-]/g, '_');
        const fp = path.join(tmpDir, `${safe}_${i}.ttf`);
        fs.writeFileSync(fp, Buffer.from(await r.arrayBuffer()));
        downloaded.push(fp);
      } catch {}
    }
    if (urls.length) console.log(`Preuzet Google Font "${name}" (${urls.length} varijante)`);
  }
  return downloaded;
}

function discoverSystemFonts() {
  const dirs = ['/usr/share/fonts/truetype/liberation', '/usr/share/fonts/truetype/dejavu'];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.ttf') || f.endsWith('.otf')) files.push(path.join(dir, f));
    }
  }
  return files;
}

function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function wrapText(text, maxChars, maxLines) {
  const words = String(text || '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const trimmed = lines.slice(0, maxLines);
    const last = trimmed[maxLines - 1];
    trimmed[maxLines - 1] = (last.length > maxChars - 3 ? last.slice(0, maxChars - 3) : last).replace(/[.,;:!?\s]+$/, '') + '…';
    return trimmed;
  }
  return lines;
}

function tspans(lines, x, y0, lh) {
  return lines.map((l, i) => `<tspan x="${x}" y="${y0 + i * lh}">${escapeXml(l)}</tspan>`).join('');
}

function charsForWidth(pxWidth, fontSize, factor = 0.54) {
  return Math.max(12, Math.floor(pxWidth / (fontSize * factor)));
}

function buildLayoutSvg(liturgy, orientation, ditherMode, style) {
  const isP = orientation === 'portrait';
  const W = isP ? 1200 : 1600, H = isP ? 1600 : 1200;
  const isDrive = ditherMode === 'spectra6';
  const paper = isDrive ? '#FFFFFF' : '#F7F4EE';
  const ink = isDrive ? '#000000' : '#1C1917';
  const muted = isDrive ? '#000000' : '#4E4841';
  const rule = isDrive ? '#000000' : '#B8B0A2';
  const accent = isDrive
    ? (liturgy.liturgicalColor === 'crvena' || liturgy.liturgicalColor === 'ružičasta' ? '#FF0000' : liturgy.liturgicalColor === 'zelena' ? '#00AA00' : '#0000FF')
    : (liturgy.liturgicalColor === 'crvena' || liturgy.liturgicalColor === 'ružičasta' ? '#B02E26' : liturgy.liturgicalColor === 'bijela' ? '#9E7816' : liturgy.liturgicalColor === 'zelena' ? '#2E7442' : '#214C94');

  const serif = `${style.serifFont}, Liberation Serif, DejaVu Serif, serif`;
  const sans = `${style.sansFont}, Liberation Sans, DejaVu Sans, sans-serif`;

  const dateHeader = (liturgy.displayDateHr || '').toUpperCase();
  const refText = (liturgy.gospelReference || '').toUpperCase();
  const subMeta = [liturgy.saintOrFeast, liturgy.liturgicalDay]
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .join('  ·  ')
    .toUpperCase();
  const cleanVerse = String(liturgy.keyVerse || '').replace(/^[„"”]+|[„"”]+$/g, '');

  const clampNum = (v, min, max) => Math.max(min, Math.min(max, Number(v) || min));
  const dateSz = clampNum(style.dateSize, 20, 48);
  const metaSz = clampNum(style.metaSize, 18, 38);
  const titleSz = clampNum(style.titleSize, 36, 86);
  const sumSz = clampNum(style.summarySize, 24, 54);
  const verseSz = clampNum(style.verseSize, 22, 50);
  const reflSz = clampNum(style.reflectionSize, 18, 40);

  if (isP) {
    const padX = 68;
    const textW = W - padX * 2;
    const headerY1 = 56 + dateSz;
    const headerY2 = headerY1 + Math.round(metaSz * 1.45);
    const topRuleY = headerY2 + 18;
    const artX = padX;
    const artY = topRuleY + 20;
    const artW = textW;
    const artH = clampNum(style.artHeightPortrait, 360, 820);

    const titleLh = Math.round(titleSz * 1.12);
    const sumLh = Math.round(sumSz * 1.32);
    const verseLh = Math.round(verseSz * 1.28);
    const reflLh = Math.round(reflSz * 1.28);

    const titleLines = wrapText(liturgy.title, charsForWidth(textW, titleSz, 0.56), 2);
    const summaryLines = wrapText(liturgy.shortSummary, charsForWidth(textW, sumSz, 0.51), 5);
    const verseLines = cleanVerse ? wrapText(`„${cleanVerse}”`, charsForWidth(textW, verseSz, 0.50), 3) : [];
    const reflLines = style.showReflection ? wrapText(liturgy.dailyReflection, charsForWidth(textW, reflSz, 0.51), 2) : [];

    let y = artY + artH + 22;
    const titleY = y + titleSz;
    y = titleY + (titleLines.length - 1) * titleLh + 30;
    const rule1Y = y;
    const summaryY = rule1Y + Math.round(sumSz * 1.28);
    y = summaryY + Math.max(0, summaryLines.length - 1) * sumLh + 32;

    const maxBottom = H - 62;
    const reflBlockH = reflLines.length ? reflLines.length * reflLh + 28 : 0;
    const verseBlockH = verseLines.length ? verseLines.length * verseLh + 44 : 0;
    const quoteTopY = Math.min(y, maxBottom - reflBlockH - verseBlockH);
    const quoteY = quoteTopY + Math.round(verseSz * 1.24);
    const quoteBottomY = quoteY + Math.max(0, verseLines.length - 1) * verseLh + 28;
    const footerY = Math.min(quoteBottomY + Math.round(reflSz * 1.38), maxBottom - Math.max(0, reflLines.length - 1) * reflLh);

    const sqSize = Math.round(dateSz * 0.52);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="${paper}"/>
      <rect x="34" y="34" width="${W - 68}" height="${H - 68}" fill="none" stroke="${ink}" stroke-width="2.5"/>
      <rect x="${padX}" y="${headerY1 - sqSize - 3}" width="${sqSize}" height="${sqSize}" fill="${accent}"/>
      <text x="${padX + sqSize + 14}" y="${headerY1}" font-family="${sans}" font-size="${dateSz}" font-weight="700" letter-spacing="0.6" fill="${ink}">${escapeXml(dateHeader)}</text>
      <text x="${W - padX}" y="${headerY1}" text-anchor="end" font-family="${sans}" font-size="${Math.round(dateSz * 0.84)}" font-weight="700" letter-spacing="0.6" fill="${accent}">${escapeXml(refText)}</text>
      <text x="${padX}" y="${headerY2}" font-family="${sans}" font-size="${metaSz}" font-weight="700" letter-spacing="0.8" fill="${muted}">${escapeXml(subMeta)}</text>
      <line x1="${padX}" y1="${topRuleY}" x2="${W - padX}" y2="${topRuleY}" stroke="${rule}" stroke-width="2"/>
      <rect x="${artX - 2}" y="${artY - 2}" width="${artW + 4}" height="${artH + 4}" fill="none" stroke="${ink}" stroke-width="2"/>
      <text font-family="${serif}" font-size="${titleSz}" font-weight="700" fill="${ink}">${tspans(titleLines, padX, titleY, titleLh)}</text>
      <line x1="${padX}" y1="${rule1Y}" x2="${W - padX}" y2="${rule1Y}" stroke="${rule}" stroke-width="1.5"/>
      <text font-family="${serif}" font-size="${sumSz}" fill="${ink}">${tspans(summaryLines, padX, summaryY, sumLh)}</text>
      ${verseLines.length ? `<line x1="${padX}" y1="${quoteTopY}" x2="${W - padX}" y2="${quoteTopY}" stroke="${accent}" stroke-width="2"/>
      <text font-family="${serif}" font-size="${verseSz}" font-style="italic" fill="${accent}">${tspans(verseLines, padX, quoteY, verseLh)}</text>
      <line x1="${padX}" y1="${quoteBottomY}" x2="${W - padX}" y2="${quoteBottomY}" stroke="${rule}" stroke-width="1.5"/>` : ''}
      ${reflLines.length ? `<text font-family="${sans}" font-size="${reflSz}" fill="${muted}">${tspans(reflLines, padX, footerY, reflLh)}</text>` : ''}
    </svg>`;
    return { W, H, artX, artY, artW, artH, svg };
  }

  // Pejzaž (1600 x 1200)
  const artX = 54, artY = 54, artW = 700, artH = 1092, textX = 804, textRight = 1546;
  const textW = textRight - textX;
  const lDateSz = Math.round(dateSz * 0.88);
  const lMetaSz = Math.round(metaSz * 0.92);
  const lTitleSz = Math.round(titleSz * 0.88);
  const lSumSz = Math.round(sumSz * 0.9);
  const lVerseSz = Math.round(verseSz * 0.9);
  const lReflSz = Math.round(reflSz * 0.9);

  const titleLh = Math.round(lTitleSz * 1.12);
  const sumLh = Math.round(lSumSz * 1.32);
  const verseLh = Math.round(lVerseSz * 1.28);
  const reflLh = Math.round(lReflSz * 1.28);

  const titleLines = wrapText(liturgy.title, charsForWidth(textW, lTitleSz, 0.56), 3);
  const summaryLines = wrapText(liturgy.shortSummary, charsForWidth(textW, lSumSz, 0.51), 6);
  const verseLines = cleanVerse ? wrapText(`„${cleanVerse}”`, charsForWidth(textW, lVerseSz, 0.50), 3) : [];
  const reflLines = style.showReflection ? wrapText(liturgy.dailyReflection, charsForWidth(textW, lReflSz, 0.51), 2) : [];

  const dateY = 58 + lDateSz;
  const metaY = dateY + Math.round(lMetaSz * 1.45);
  let y = metaY + 26;
  const titleY = y + lTitleSz;
  y = titleY + (titleLines.length - 1) * titleLh + 28;
  const rule1Y = y;
  const summaryY = rule1Y + Math.round(lSumSz * 1.26);
  y = summaryY + Math.max(0, summaryLines.length - 1) * sumLh + 34;

  const maxBottom = H - 62;
  const reflBlockH = reflLines.length ? reflLines.length * reflLh + 28 : 0;
  const verseBlockH = verseLines.length ? verseLines.length * verseLh + 44 : 0;
  const quoteTopY = Math.min(y, maxBottom - reflBlockH - verseBlockH);
  const quoteY = quoteTopY + Math.round(lVerseSz * 1.24);
  const quoteBottomY = quoteY + Math.max(0, verseLines.length - 1) * verseLh + 28;
  const footerY = Math.min(quoteBottomY + Math.round(lReflSz * 1.38), maxBottom - Math.max(0, reflLines.length - 1) * reflLh);

  const sqSize = Math.round(lDateSz * 0.52);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${paper}"/>
    <rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="${ink}" stroke-width="2.5"/>
    <rect x="${artX - 2}" y="${artY - 2}" width="${artW + 4}" height="${artH + 4}" fill="none" stroke="${ink}" stroke-width="2"/>
    <rect x="${textX}" y="${dateY - sqSize - 3}" width="${sqSize}" height="${sqSize}" fill="${accent}"/>
    <text x="${textX + sqSize + 14}" y="${dateY}" font-family="${sans}" font-size="${lDateSz}" font-weight="700" fill="${ink}">${escapeXml(dateHeader)}</text>
    <text x="${textX}" y="${metaY}" font-family="${sans}" font-size="${lMetaSz}" font-weight="700" fill="${accent}">${escapeXml([refText, liturgy.saintOrFeast?.toUpperCase()].filter(Boolean).join('  ·  '))}</text>
    <text font-family="${serif}" font-size="${lTitleSz}" font-weight="700" fill="${ink}">${tspans(titleLines, textX, titleY, titleLh)}</text>
    <line x1="${textX}" y1="${rule1Y}" x2="${textRight}" y2="${rule1Y}" stroke="${rule}" stroke-width="1.5"/>
    <text font-family="${serif}" font-size="${lSumSz}" fill="${ink}">${tspans(summaryLines, textX, summaryY, sumLh)}</text>
    ${verseLines.length ? `<line x1="${textX}" y1="${quoteTopY}" x2="${textRight}" y2="${quoteTopY}" stroke="${accent}" stroke-width="2"/>
    <text font-family="${serif}" font-size="${lVerseSz}" font-style="italic" fill="${accent}">${tspans(verseLines, textX, quoteY, verseLh)}</text>
    <line x1="${textX}" y1="${quoteBottomY}" x2="${textRight}" y2="${quoteBottomY}" stroke="${rule}" stroke-width="1.5"/>` : ''}
    ${reflLines.length ? `<text font-family="${sans}" font-size="${lReflSz}" fill="${muted}">${tspans(reflLines, textX, footerY, reflLh)}</text>` : ''}
  </svg>`;
  return { W, H, artX, artY, artW, artH, svg };
}

async function composeCanvas(liturgy, rawArtBuf, orientation, ditherMode, fontFiles, style) {
  const geom = buildLayoutSvg(liturgy, orientation, ditherMode, style);
  let artPipe = sharp(rawArtBuf).resize(geom.artW, geom.artH, { fit: 'cover', position: 'center' });
  if (ditherMode !== 'original') artPipe = artPipe.modulate({ saturation: 1.18, brightness: 1.02 });
  const { data, info } = await artPipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const artPng = ditherMode === 'original'
    ? await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
    : await sharp(applySpectra6Dither(data, info.width, info.height, ditherMode === 'spectra6'), {
        raw: { width: info.width, height: info.height, channels: 4 },
      }).png().toBuffer();

  const layoutPng = new Resvg(geom.svg, {
    fitTo: { mode: 'width', value: geom.W },
    font: { fontFiles, loadSystemFonts: fontFiles.length === 0, defaultFontFamily: style.serifFont || 'Liberation Serif' },
  }).render().asPng();

  return sharp(layoutPng).composite([{ input: artPng, left: geom.artX, top: geom.artY }]);
}

async function renderE6(liturgy, rawArtBuf, orientation, fontFiles, style) {
  const composed = await (await composeCanvas(liturgy, rawArtBuf, orientation, 'spectra6', fontFiles, style))
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const finalRaw = orientation === 'landscape'
    ? await sharp(composed.data, { raw: { width: composed.info.width, height: composed.info.height, channels: 3 } })
        .rotate(90).raw().toBuffer({ resolveWithObject: true })
    : composed;

  const { data, info } = finalRaw;
  if (info.width !== 1200 || info.height !== 1600 || info.channels !== 3) {
    throw new Error(`Neispravne .e6 dimenzije: ${info.width}x${info.height}`);
  }

  const out = Buffer.alloc(16 + (1200 * 1600) / 2);
  out.write('E6IM', 0, 'ascii');
  out.writeUInt16LE(1200, 4);
  out.writeUInt16LE(1600, 6);
  for (let i = 0, s = 0, o = 16; i < (1200 * 1600) / 2; i++, s += 6) {
    const a = nearestE6Index(data[s], data[s + 1], data[s + 2]);
    const b = nearestE6Index(data[s + 3], data[s + 4], data[s + 5]);
    out[o++] = (a << 4) | b;
  }
  return out;
}

async function main() {
  const style = loadStyleConfig();
  const dateIso = getZagrebDateIso();
  const displayDateHr = formatCroatianDate(dateIso);
  console.log(`Generiram dnevno čitanje za ${dateIso} (${displayDateHr})…`);

  const hilp = await fetchHilpReading(dateIso);
  const ai = await generateSummaryWithAI(hilp, displayDateHr);
  const liturgy = {
    date: dateIso,
    displayDateHr,
    liturgicalDay: hilp?.liturgicalWeek || hilp?.liturgicalRank || 'Svagdan',
    liturgicalSeason: hilp?.liturgicalSeason || 'Vrijeme kroz godinu',
    liturgicalColor: hilp?.liturgicalColor || 'zelena',
    saintOrFeast: hilp?.liturgicalRank || hilp?.liturgicalWeek || '',
    gospelReference: hilp?.gospelRef || '',
    title: ai.title || hilp?.gospelHeadline || 'Dnevno evanđelje',
    shortSummary: ai.shortSummary || '',
    keyVerse: ai.keyVerse || '',
    dailyReflection: ai.dailyReflection || '',
    artUrl: './today-art.jpg',
    sourceUrl: hilp?.url || 'https://hilp.hr',
    generatedAt: new Date().toISOString(),
  };

  const rawArt = await generateArtworkBuffer(ai.imagePrompt, liturgy.liturgicalColor);
  const gFonts = await downloadGoogleFonts([style.serifFont, style.sansFont]);
  const fontFiles = [...gFonts, ...discoverSystemFonts()];
  console.log(`Ukupno učitano font datoteka: ${fontFiles.length}`);

  const dist = path.resolve(process.cwd(), 'dist');
  fs.mkdirSync(path.join(dist, 'api', 'e1004'), { recursive: true });

  const artJpg = await sharp(rawArt).jpeg({ quality: 92 }).toBuffer();
  const portraitE6 = await renderE6(liturgy, rawArt, 'portrait', fontFiles, style);
  const landscapeE6 = await renderE6(liturgy, rawArt, 'landscape', fontFiles, style);
  const portraitPng = await (await composeCanvas(liturgy, rawArt, 'portrait', 'original', fontFiles, style)).png({ compressionLevel: 9 }).toBuffer();
  const landscapePng = await (await composeCanvas(liturgy, rawArt, 'landscape', 'original', fontFiles, style)).png({ compressionLevel: 9 }).toBuffer();

  fs.writeFileSync(path.join(dist, 'today.e6'), portraitE6);
  fs.writeFileSync(path.join(dist, 'today-landscape.e6'), landscapeE6);
  fs.writeFileSync(path.join(dist, 'today.png'), portraitPng);
  fs.writeFileSync(path.join(dist, 'today-landscape.png'), landscapePng);
  fs.writeFileSync(path.join(dist, 'today-art.jpg'), artJpg);
  fs.writeFileSync(path.join(dist, 'api', 'e1004', 'render.e6'), portraitE6);
  fs.writeFileSync(path.join(dist, 'api', 'e1004', 'render.png'), portraitPng);

  const apiPayload = JSON.stringify({ liturgy, style }, null, 2);
  fs.writeFileSync(path.join(dist, 'api', 'daily'), apiPayload);
  fs.writeFileSync(path.join(dist, 'daily.json'), apiPayload);
  fs.writeFileSync(path.join(dist, '.nojekyll'), '');

  const previewHtml = `<!DOCTYPE html><html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dnevno čitanje · reTerminal E1004</title>
<style>body{font-family:Georgia,serif;background:#f7f4ee;color:#1c1917;max-width:760px;margin:28px auto;padding:0 16px;line-height:1.5}
img{max-width:100%;height:auto;border:1px solid #1c1917;background:#fff}a{color:#2e7442;font-weight:700}</style>
</head><body>
<h1>${escapeXml(liturgy.title)}</h1>
<p><b>${escapeXml(liturgy.displayDateHr)}</b> · ${escapeXml(liturgy.gospelReference)}</p>
<p><img src="./today.png" alt="Današnji prikaz za reTerminal E1004"></p>
<p>Datoteke za reTerminal E1004:<br>
• Portret: <a href="./today.e6">today.e6</a> (${portraitE6.length} B)<br>
• Pejzaž: <a href="./today-landscape.e6">today-landscape.e6</a> (${landscapeE6.length} B)<br>
• Sama AI ilustracija: <a href="./today-art.jpg">today-art.jpg</a><br>
• Podaci (JSON): <a href="./daily.json">daily.json</a></p>
</body></html>`;
  fs.writeFileSync(path.join(dist, 'index.html'), previewHtml);

  console.log(`GOTOVO! today.e6 = ${portraitE6.length} B, today-landscape.e6 = ${landscapeE6.length} B`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
