import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

export interface PreparedImage {
  pngPath: string;
  pngBuffer: Buffer;
  cols: number;
  rows: number;
}

export async function prepareImageForKitty(imageSource: string, maxCols = 38, maxRows = 16): Promise<PreparedImage | null> {
  try {
    if (!fs.existsSync(imageSource)) return null;

    const parsed = path.parse(imageSource);
    const mediaDir = path.dirname(imageSource);
    const pngPath = path.join(mediaDir, `${parsed.name}.png`);

    let pngBuffer: Buffer;

    if (fs.existsSync(pngPath)) {
      pngBuffer = fs.readFileSync(pngPath);
    } else {
      pngBuffer = await sharp(imageSource)
        .resize(maxCols * 24, maxRows * 48, { fit: 'inside' })
        .png({ quality: 100 })
        .toBuffer();
      fs.writeFileSync(pngPath, pngBuffer);
    }

    const metadata = await sharp(pngBuffer).metadata();
    const width = metadata.width || 400;
    const height = metadata.height || 300;

    // Terminal cells are approx 1:2 (width:height)
    const aspect = width / (height * 0.5);

    let cols = maxCols;
    let rows = Math.round(cols / aspect);

    if (rows > maxRows) {
      rows = maxRows;
      cols = Math.round(rows * aspect);
    }

    cols = Math.max(10, Math.min(maxCols, cols));
    rows = Math.max(6, Math.min(maxRows, rows));

    return { pngPath, pngBuffer, cols, rows };
  } catch {
    return null;
  }
}

export function createKittyPlacement(item: PreparedImage, screenX: number, screenY: number): string {
  // Use t=f with the genuine PNG file on disk for instant native rendering
  if (item.pngPath && fs.existsSync(item.pngPath)) {
    const b64Path = Buffer.from(item.pngPath).toString('base64');
    return `\x1b7\x1b[${screenY};${screenX}H\x1b_Ga=T,f=100,t=f,c=${item.cols},r=${item.rows};${b64Path}\x1b\\\x1b8`;
  }

  // Fallback to chunked base64 transmission of PNG buffer
  const b64 = item.pngBuffer.toString('base64');
  const chunkSize = 4096;
  let out = `\x1b7\x1b[${screenY};${screenX}H`;

  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= b64.length;
    const m = isLast ? 0 : 1;

    if (i === 0) {
      out += `\x1b_Ga=T,f=100,c=${item.cols},r=${item.rows},m=${m};${chunk}\x1b\\`;
    } else {
      out += `\x1b_Gm=${m};${chunk}\x1b\\`;
    }
  }

  out += '\x1b8';
  return out;
}

export function clearAllKittyImages(): string {
  return '\x1b_Ga=d,d=a\x1b\\';
}
