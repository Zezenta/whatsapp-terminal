import sharp from 'sharp';
import fs from 'node:fs';

export interface PreparedImage {
  filePath?: string;
  pngBuffer: Buffer;
  cols: number;
  rows: number;
}

export async function prepareImageForKitty(imageSource: Buffer | string, maxCols = 34, maxRows = 16): Promise<PreparedImage | null> {
  try {
    let input: Buffer;
    let filePath: string | undefined;

    if (typeof imageSource === 'string') {
      if (!fs.existsSync(imageSource)) return null;
      filePath = imageSource;
      input = fs.readFileSync(imageSource);
    } else {
      input = imageSource;
    }

    if (!input || input.length === 0) return null;

    const metadata = await sharp(input).metadata();
    const origWidth = metadata.width || 400;
    const origHeight = metadata.height || 300;

    // Estimate cell aspect ratio: 1 cell is approx 1:2 width to height
    const aspect = origWidth / (origHeight * 0.5);

    let cols = maxCols;
    let rows = Math.round(cols / aspect);

    if (rows > maxRows) {
      rows = maxRows;
      cols = Math.round(rows * aspect);
    }

    cols = Math.max(8, Math.min(maxCols, cols));
    rows = Math.max(4, Math.min(maxRows, rows));

    const pngBuffer = await sharp(input)
      .resize(cols * 16, rows * 32, { fit: 'inside' })
      .png()
      .toBuffer();

    return { filePath, pngBuffer, cols, rows };
  } catch {
    return null;
  }
}

export function createKittyPlacement(item: PreparedImage, screenX: number, screenY: number): string {
  // If we have a local file on disk, use Kitty direct file transmission (t=f) for instant GPU loading
  if (item.filePath && fs.existsSync(item.filePath)) {
    const b64Path = Buffer.from(item.filePath).toString('base64');
    return `\x1b7\x1b[${screenY};${screenX}H\x1b_Ga=T,f=100,t=f,c=${item.cols},r=${item.rows};${b64Path}\x1b\\\x1b8`;
  }

  // Otherwise transmit PNG buffer in chunks
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
