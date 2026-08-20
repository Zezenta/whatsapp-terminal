import sharp from 'sharp';
import fs from 'node:fs';

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
