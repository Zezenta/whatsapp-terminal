import sharp from 'sharp';
import fs from 'node:fs';

export interface PreparedImage {
  pngBuffer: Buffer;
  cols: number;
  rows: number;
}

export async function prepareImageForKitty(imageSource: Buffer | string, maxCols = 32, maxRows = 14): Promise<PreparedImage | null> {
  try {
    let input: Buffer;
    if (typeof imageSource === 'string') {
      if (!fs.existsSync(imageSource)) return null;
      input = fs.readFileSync(imageSource);
    } else {
      input = imageSource;
    }

    if (!input || input.length === 0) return null;

    // Convert to PNG with max pixel bounds
    const maxPixelWidth = maxCols * 10;
    const maxPixelHeight = maxRows * 20;

    const pngBuffer = await sharp(input)
      .resize(maxPixelWidth, maxPixelHeight, { fit: 'inside' })
      .png()
      .toBuffer();

    const metadata = await sharp(pngBuffer).metadata();
    const width = metadata.width || maxPixelWidth;
    const height = metadata.height || maxPixelHeight;

    const cols = Math.max(4, Math.min(maxCols, Math.round(width / 10)));
    const rows = Math.max(2, Math.min(maxRows, Math.round(height / 20)));

    return { pngBuffer, cols, rows };
  } catch {
    return null;
  }
}

export function createKittyPlacement(pngBuffer: Buffer, screenX: number, screenY: number, cols: number, rows: number, imageId?: number): string {
  const b64 = pngBuffer.toString('base64');
  const chunkSize = 4096;
  let out = `\x1b[${screenY};${screenX}H`;
  const idParam = imageId ? `,i=${imageId}` : '';

  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= b64.length;
    const m = isLast ? 0 : 1;

    if (i === 0) {
      out += `\x1b_Ga=T,f=100${idParam},c=${cols},r=${rows},m=${m};${chunk}\x1b\\`;
    } else {
      out += `\x1b_Gm=${m};${chunk}\x1b\\`;
    }
  }

  return out;
}

export function clearAllKittyImages(): string {
  return '\x1b_Ga=d,d=a\x1b\\';
}

export async function generateAnsiThumbnail(imageSource: Buffer | string, maxWidth = 34, maxHeight = 16): Promise<string> {
  try {
    let input: Buffer;
    if (typeof imageSource === 'string') {
      if (!fs.existsSync(imageSource)) return '';
      input = fs.readFileSync(imageSource);
    } else {
      input = imageSource;
    }

    if (!input || input.length === 0) return '';

    const { data, info } = await sharp(input)
      .resize(maxWidth, maxHeight * 2, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    let lines: string[] = [];

    for (let y = 0; y < height; y += 2) {
      let line = '  ';
      for (let x = 0; x < width; x++) {
        const topIdx = (y * width + x) * channels;
        const botIdx = ((y + 1) * width + x) * channels;

        const tr = data[topIdx], tg = data[topIdx + 1], tb = data[topIdx + 2], ta = data[topIdx + 3];
        const hasBottom = y + 1 < height;
        const br = hasBottom ? data[botIdx] : 0;
        const bg = hasBottom ? data[botIdx + 1] : 0;
        const bb = hasBottom ? data[botIdx + 2] : 0;
        const ba = hasBottom ? data[botIdx + 3] : 0;

        if (ta < 32 && (!hasBottom || ba < 32)) {
          line += ' ';
        } else if (ta < 32 && ba >= 32) {
          line += `\x1b[38;2;${br};${bg};${bb}m▄\x1b[0m`;
        } else if (ta >= 32 && (!hasBottom || ba < 32)) {
          line += `\x1b[38;2;${tr};${tg};${tb}m▀\x1b[0m`;
        } else {
          line += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m▀\x1b[0m`;
        }
      }
      lines.push(line);
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}
