import QRCode from 'qrcode';

export function renderQRToUnicode(text: string): { qr: string; width: number; height: number } {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'L' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const border = 2;
  const totalWidth = size + border * 2;

  const isDark = (r: number, c: number): boolean => {
    if (r < 0 || r >= size || c < 0 || c >= size) return false;
    return Boolean(data[r * size + c]);
  };

  const lines: string[] = [];
  for (let r = -border; r < size + border; r += 2) {
    let line = '';
    for (let c = -border; c < size + border; c++) {
      const top = isDark(r, c);
      const bottom = isDark(r + 1, c);

      if (!top && !bottom) {
        line += '█';
      } else if (!top && bottom) {
        line += '▀';
      } else if (top && !bottom) {
        line += '▄';
      } else {
        line += ' ';
      }
    }
    lines.push(line);
  }

  return {
    qr: lines.join('\n'),
    width: totalWidth,
    height: lines.length
  };
}
