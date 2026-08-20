import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// Disable sharp/libvips mmap file caching to prevent SIGBUS on concurrent file access
sharp.cache(false);

export interface PreparedImage {
  pngPath: string;
  pngBuffer: Buffer;
  cols: number;
  rows: number;
}

export async function prepareImageForKitty(imageSource: string, maxCols = 34, maxRows = 11): Promise<PreparedImage | null> {
  try {
    if (!fs.existsSync(imageSource)) return null;

    const parsed = path.parse(imageSource);
    const mediaDir = path.dirname(imageSource);
    const pngPath = path.join(mediaDir, `${parsed.name}_${maxCols}x${maxRows}.png`);

    let pngBuffer: Buffer;

    if (fs.existsSync(pngPath)) {
      pngBuffer = fs.readFileSync(pngPath);
    } else {
      // Read directly into memory buffer to avoid libvips mmap SIGBUS conflicts
      const rawInputBuffer = fs.readFileSync(imageSource);
      if (!rawInputBuffer || rawInputBuffer.length === 0) return null;

      pngBuffer = await sharp(rawInputBuffer)
        .resize(maxCols * 24, maxRows * 48, { fit: 'inside' })
        .png({ quality: 95 })
        .toBuffer();

      // Atomic write via temporary file
      const tempPath = `${pngPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tempPath, pngBuffer);
      fs.renameSync(tempPath, pngPath);
    }

    const metadata = await sharp(pngBuffer).metadata();
    const width = metadata.width || 400;
    const height = metadata.height || 300;

    // Terminal cells are approx 1:2 width to height
    const aspect = width / (height * 0.5);

    let cols = maxCols;
    let rows = Math.round(cols / aspect);

    if (rows > maxRows) {
      rows = maxRows;
      cols = Math.round(rows * aspect);
    }

    cols = Math.max(4, Math.min(maxCols, cols));
    rows = Math.max(2, Math.min(maxRows, rows));

    return { pngPath, pngBuffer, cols, rows };
  } catch {
    return null;
  }
}

export function createKittyPlacement(item: PreparedImage, screenX: number, screenY: number): string {
  let out = `\x1b[s\x1b[${screenY};${screenX}H`;

  const b64 = item.pngBuffer.toString('base64');
  const chunkSize = 4096;

  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= b64.length;
    const m = isLast ? 0 : 1;

    if (i === 0) {
      out += `\x1b_Ga=T,f=100,z=1,q=2,c=${item.cols},r=${item.rows},m=${m};${chunk}\x1b\\`;
    } else {
      out += `\x1b_Gm=${m};${chunk}\x1b\\`;
    }
  }

  out += '\x1b[u';
  return out;
}

export function clearAllKittyImages(): string {
  return '\x1b_Ga=d,d=a,q=2\x1b\\';
}
