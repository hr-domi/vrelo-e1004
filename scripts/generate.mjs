import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';

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
          'User-Agent': 'Mozilla/5.0 (compatible; VreloE1004/1.4; +https://hilp.hr)',
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
    'Ti si urednik hrvatskog katoličkog liturgijskog kalendara za E Ink ekran.',
    'Na temelju današnjeg evanđelja s hilp.hr napiši ISKLJUČIVO valjani JSON objekt (bez dodatnog teksta) sa sljedećim poljima:',
    '- "title": kratak, snažan naslov na hrvatskom (3 do 7 riječi)',
    '- "shortSummary": sažetak evanđelja u 2 do 3 jasne, tople rečenice na prirodnom hrvatskom (ukupno 180 do 270 znakova)',
    '- "keyVerse": jedan kratak, najupečatljiviji redak iz evanđelja (bez vanjskih navodnika, do 115 znakova)',
    '- "dailyReflection": kratka duhovna misao dana u 1 rečenici (do 115 znakova)',
    '- "imagePrompt": opis prizora za ilustraciju NA ENGLESKOM (1-2 rečenice) u stilu toplog klasičnog drvoreza / ulja na platnu sa sakralnom simbolikom, BEZ ikakvog teksta, slova ili natpisa na slici, izražajnog kontrasta i čistih tonova (krem, crvena, oker zlatna, modra, maslinasto zelena, tamna tinta).',
    '',
    `Datum: ${displayDateHr}`,
    `Liturgijski dan: ${hilp?.liturgicalWeek || hilp?.liturgicalRank || 'Svagdan'}`,
    `Evanđelje (${hilp?.gospelRef || ''}): ${hilp?.gospelHeadline || ''}`,
    `Misao dana: ${hilp?.thoughtOfTheDay || ''}`,
    `Tekst evanđelja: ${(hilp?.gospelText || '').slice(0, 1800)}`,
  ].join('\n');

  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (geminiKey) {
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
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
                temperature: 0.4,
                responseMimeType: 'application/json',
              },
            }),
          }
        );
        if (!r.ok) {
          console.warn(`Gemini ${model} HTTP ${r.status}`);
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
    const cfModels = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
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
                { role: 'system', content: 'Odgovaraj isključivo čistim JSON objektom na hrvatskom jeziku.' },
                { role: 'user', content: prompt },
              ],
            }),
          }
        );
        if (!r.ok) continue;
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
    shortSummary: (hilp?.gospelText || 'Čitanje iz dnevnog evanđelja.').slice(0, 250).replace(/\s+\S*$/, '…'),
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1048" height="790" viewBox="0 0 1048 790">
    <rect width="1048" height="790" fill="#F2EDE1"/>
    <rect x="28" y="28" width="992" height="734" fill="none" stroke="#1C1917" stroke-width="4"/>
    <path d="M164 762 L164 360 A360 360 0 0 1 884 360 L884 762 Z" fill="#214C94" opacity="0.16"/>
    <path d="M224 762 L224 380 A300 300 0 0 1 824 380 L824 762 Z" fill="none" stroke="${accent}" stroke-width="5"/>
    <circle cx="524" cy="310" r="145" fill="#E2BC30" opacity="0.88"/>
    <circle cx="524" cy="310" r="175" fill="none" stroke="#1C1917" stroke-width="3" stroke-dasharray="10 10"/>
    <path d="M120 690 Q340 530 524 610 T928 650 L928 762 L120 762 Z" fill="${accent}"/>
    <path d="M120 735 Q390 610 640 690 T928 710 L928 762 L120 762 Z" fill="#1C1917"/>
    <rect x="506" y="165" width="36" height="310" fill="#1C1917"/>
    <rect x="414" y="255" width="220" height="36" fill="#1C1917"/>
    <rect x="514" y="173" width="20" height="294" fill="#F2EDE1"/>
    <rect x="422" y="263" width="204" height="20" fill="#F2EDE1"/>
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
  return new Resvg(svg, { fitTo: { mode: 'width', value: 1048 }, font: { loadSystemFonts: false } }).render().asPng();
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

function discoverFonts() {
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

function buildLayoutSvg(liturgy, orientation, ditherMode) {
  const isP = orientation === 'portrait';
  const W = isP ? 1200 : 1600, H = isP ? 1600 : 1200;
  const isDrive = ditherMode === 'spectra6';
  const paper = isDrive ? '#FFFFFF' : '#F7F4EE';
  const ink = isDrive ? '#000000' : '#1C1917';
  const muted = isDrive ? '#000000' : '#5C564F';
  const rule = isDrive ? '#000000' : '#B8B0A2';
  const accent = isDrive
    ? (liturgy.liturgicalColor === 'crvena' || liturgy.liturgicalColor === 'ružičasta' ? '#FF0000' : liturgy.liturgicalColor === 'zelena' ? '#00AA00' : '#0000FF')
    : (liturgy.liturgicalColor === 'crvena' || liturgy.liturgicalColor === 'ružičasta' ? '#B02E26' : liturgy.liturgicalColor === 'bijela' ? '#9E7816' : liturgy.liturgicalColor === 'zelena' ? '#2E7442' : '#214C94');

  const serif = 'Liberation Serif, DejaVu Serif, serif';
  const sans = 'Liberation Sans, DejaVu Sans, sans-serif';
  const dateHeader = (liturgy.displayDateHr || '').toUpperCase();
  const seasonMeta = [liturgy.liturgicalSeason, liturgy.gospelReference].filter(Boolean).join('  ·  ').toUpperCase();
  const kicker = (liturgy.saintOrFeast || liturgy.liturgicalDay || 'DNEVNO ČITANJE').toUpperCase();
  const cleanVerse = String(liturgy.keyVerse || '').replace(/^[„"”]+|[„"”]+$/g, '');

  if (isP) {
    const artX = 76, artY = 148, artW = 1048, artH = 790, padX = 76;
    const titleLines = wrapText(liturgy.title, 34, 2);
    const summaryLines = wrapText(liturgy.shortSummary, 68, 4);
    const verseLines = cleanVerse ? wrapText(`„${cleanVerse}”`, 62, 2) : [];
    const reflLines = wrapText(liturgy.dailyReflection, 78, 2);

    let y = 984;
    const kickerY = y;
    const titleY = kickerY + 56;
    y = titleY + (titleLines.length - 1) * 58 + 26;
    const ruleY = y;
    const summaryY = ruleY + 46;
    y = summaryY + (summaryLines.length - 1) * 43 + 42;
    const quoteTopY = Math.min(y, 1345);
    const quoteY = quoteTopY + 44;
    const quoteBottomY = quoteY + Math.max(0, verseLines.length - 1) * 40 + 28;
    const footerY = Math.min(quoteBottomY + 46, 1502);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="${paper}"/>
      <rect x="40" y="40" width="1120" height="1520" fill="none" stroke="${ink}" stroke-width="2"/>
      <rect x="${padX}" y="82" width="15" height="15" fill="${accent}"/>
      <text x="${padX + 27}" y="96" font-family="${sans}" font-size="19" font-weight="700" letter-spacing="1.6" fill="${ink}">${escapeXml(dateHeader)}</text>
      <text x="${W - padX}" y="96" text-anchor="end" font-family="${sans}" font-size="18" font-weight="700" letter-spacing="1.2" fill="${muted}">${escapeXml(seasonMeta)}</text>
      <line x1="${padX}" y1="118" x2="${W - padX}" y2="118" stroke="${rule}" stroke-width="1.5"/>
      <rect x="${artX - 2}" y="${artY - 2}" width="${artW + 4}" height="${artH + 4}" fill="none" stroke="${ink}" stroke-width="2"/>
      <text x="${padX}" y="${kickerY}" font-family="${sans}" font-size="18" font-weight="700" letter-spacing="1.8" fill="${accent}">${escapeXml(kicker)}</text>
      <text font-family="${serif}" font-size="54" font-weight="700" fill="${ink}">${tspans(titleLines, padX, titleY, 58)}</text>
      <line x1="${padX}" y1="${ruleY}" x2="${W - padX}" y2="${ruleY}" stroke="${rule}" stroke-width="1.5"/>
      <text font-family="${serif}" font-size="30" fill="${ink}">${tspans(summaryLines, padX, summaryY, 42)}</text>
      ${verseLines.length ? `<line x1="${padX}" y1="${quoteTopY}" x2="${W - padX}" y2="${quoteTopY}" stroke="${accent}" stroke-width="1.5"/>
      <text font-family="${serif}" font-size="30" font-style="italic" fill="${accent}">${tspans(verseLines, padX, quoteY, 40)}</text>
      <line x1="${padX}" y1="${quoteBottomY}" x2="${W - padX}" y2="${quoteBottomY}" stroke="${rule}" stroke-width="1"/>` : ''}
      ${reflLines.length ? `<text font-family="${sans}" font-size="20" fill="${muted}">${tspans(reflLines, padX, footerY, 28)}</text>` : ''}
    </svg>`;
    return { W, H, artX, artY, artW, artH, svg };
  }

  const artX = 58, artY = 58, artW = 780, artH = 1084, textX = 896, textRight = 1538;
  const titleLines = wrapText(liturgy.title, 24, 3);
  const summaryLines = wrapText(liturgy.shortSummary, 42, 7);
  const verseLines = cleanVerse ? wrapText(`„${cleanVerse}”`, 40, 4) : [];
  const reflLines = wrapText(liturgy.dailyReflection, 46, 3);

  let y = 165;
  const kickerY = y, titleY = kickerY + 62;
  y = titleY + (titleLines.length - 1) * 58 + 30;
  const ruleY = y, summaryY = ruleY + 50;
  y = summaryY + (summaryLines.length - 1) * 44 + 48;
  const quoteTopY = Math.min(y, 825), quoteY = quoteTopY + 46;
  const quoteBottomY = quoteY + Math.max(0, verseLines.length - 1) * 42 + 34;
  const footerY = Math.min(Math.max(quoteBottomY + 48, 1020), 1070);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${paper}"/>
    <rect x="34" y="34" width="${W - 68}" height="${H - 68}" fill="none" stroke="${ink}" stroke-width="2"/>
    <rect x="${artX - 2}" y="${artY - 2}" width="${artW + 4}" height="${artH + 4}" fill="none" stroke="${ink}" stroke-width="2"/>
    <rect x="${textX}" y="82" width="14" height="14" fill="${accent}"/>
    <text x="${textX + 26}" y="95" font-family="${sans}" font-size="18" font-weight="700" letter-spacing="1.6" fill="${ink}">${escapeXml(dateHeader)}</text>
    <text x="${textX}" y="126" font-family="${sans}" font-size="17" font-weight="700" letter-spacing="1.2" fill="${muted}">${escapeXml(seasonMeta)}</text>
    <text x="${textX}" y="${kickerY}" font-family="${sans}" font-size="18" font-weight="700" letter-spacing="1.6" fill="${accent}">${escapeXml(kicker)}</text>
    <text font-family="${serif}" font-size="52" font-weight="700" fill="${ink}">${tspans(titleLines, textX, titleY, 58)}</text>
    <line x1="${textX}" y1="${ruleY}" x2="${textRight}" y2="${ruleY}" stroke="${rule}" stroke-width="1.5"/>
    <text font-family="${serif}" font-size="30" fill="${ink}">${tspans(summaryLines, textX, summaryY, 44)}</text>
    ${verseLines.length ? `<line x1="${textX}" y1="${quoteTopY}" x2="${textRight}" y2="${quoteTopY}" stroke="${accent}" stroke-width="1.5"/>
    <text font-family="${serif}" font-size="30" font-style="italic" fill="${accent}">${tspans(verseLines, textX, quoteY, 42)}</text>
    <line x1="${textX}" y1="${quoteBottomY}" x2="${textRight}" y2="${quoteBottomY}" stroke="${rule}" stroke-width="1"/>` : ''}
    ${reflLines.length ? `<text font-family="${sans}" font-size="20" fill="${muted}">${tspans(reflLines, textX, footerY, 30)}</text>` : ''}
  </svg>`;
  return { W, H, artX, artY, artW, artH, svg };
}

async function composeCanvas(liturgy, rawArtBuf, orientation, ditherMode, fontFiles) {
  const geom = buildLayoutSvg(liturgy, orientation, ditherMode);
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
    font: { fontFiles, loadSystemFonts: fontFiles.length === 0, defaultFontFamily: 'Liberation Serif' },
  }).render().asPng();

  return sharp(layoutPng).composite([{ input: artPng, left: geom.artX, top: geom.artY }]);
}

async function renderE6(liturgy, rawArtBuf, orientation, fontFiles) {
  const composed = await (await composeCanvas(liturgy, rawArtBuf, orientation, 'spectra6', fontFiles))
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
    sourceUrl: hilp?.url || 'https://hilp.hr',
    generatedAt: new Date().toISOString(),
  };

  const rawArt = await generateArtworkBuffer(ai.imagePrompt, liturgy.liturgicalColor);
  const fontFiles = discoverFonts();
  console.log(`Pronađeno fontova: ${fontFiles.length}`);

  const dist = path.resolve(process.cwd(), 'dist');
  fs.mkdirSync(path.join(dist, 'api', 'e1004'), { recursive: true });

  const portraitE6 = await renderE6(liturgy, rawArt, 'portrait', fontFiles);
  const landscapeE6 = await renderE6(liturgy, rawArt, 'landscape', fontFiles);
  const portraitPng = await (await composeCanvas(liturgy, rawArt, 'portrait', 'original', fontFiles)).png({ compressionLevel: 9 }).toBuffer();
  const landscapePng = await (await composeCanvas(liturgy, rawArt, 'landscape', 'original', fontFiles)).png({ compressionLevel: 9 }).toBuffer();

  fs.writeFileSync(path.join(dist, 'today.e6'), portraitE6);
  fs.writeFileSync(path.join(dist, 'today-landscape.e6'), landscapeE6);
  fs.writeFileSync(path.join(dist, 'today.png'), portraitPng);
  fs.writeFileSync(path.join(dist, 'today-landscape.png'), landscapePng);
  fs.writeFileSync(path.join(dist, 'api', 'e1004', 'render.e6'), portraitE6);
  fs.writeFileSync(path.join(dist, 'api', 'e1004', 'render.png'), portraitPng);

  const apiPayload = JSON.stringify({ liturgy }, null, 2);
  fs.writeFileSync(path.join(dist, 'api', 'daily'), apiPayload);
  fs.writeFileSync(path.join(dist, 'daily.json'), apiPayload);
  fs.writeFileSync(path.join(dist, '.nojekyll'), '');

  const previewHtml = `<!DOCTYPE html><html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dnevno čitanje · reTerminal E1004</title>
<style>body{font-family:Georgia,serif;background:#f7f4ee;color:#1c1917;max-width:760px;margin:28px auto;padding:0 16px;line-height:1.5}
img{max-width:100%;height:auto;border:1px solid #1c1917;background:#fff}a{color:#2e7442;font-weight:700}code{background:#ebe5d8;padding:2px 6px}</style>
</head><body>
<h1>${escapeXml(liturgy.title)}</h1>
<p><b>${escapeXml(liturgy.displayDateHr)}</b> · ${escapeXml(liturgy.gospelReference)}</p>
<p><img src="./today.png" alt="Današnji prikaz za reTerminal E1004"></p>
<p>Datoteke za reTerminal E1004:<br>
• Portret: <a href="./today.e6">today.e6</a> (${portraitE6.length} B)<br>
• Pejzaž: <a href="./today-landscape.e6">today-landscape.e6</a> (${landscapeE6.length} B)<br>
• Podaci (JSON): <a href="./daily.json">daily.json</a></p>
</body></html>`;
  fs.writeFileSync(path.join(dist, 'index.html'), previewHtml);

  console.log(`GOTOVO! today.e6 = ${portraitE6.length} B, today-landscape.e6 = ${landscapeE6.length} B`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
