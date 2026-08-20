import blessed from 'blessed';

export function patchBlessedUnicode() {
  const unicode = (blessed as any).unicode;
  if (!unicode) return;

  const origCharWidth = unicode.charWidth;

  // Mark variation selectors, ZWJ and skin-tone modifiers as combining (0-width)
  for (let code = 0xfe00; code <= 0xfe0f; code++) {
    unicode.combining[code] = true;
  }
  unicode.combining[0x200d] = true; // Zero-width joiner
  for (let code = 0x1f3fb; code <= 0x1f3ff; code++) {
    unicode.combining[code] = true; // Skin tone modifiers
  }

  function isModernEmoji(point: number): boolean {
    if (point >= 0x2600 && point <= 0x27bf) return true; // Dingbats, Misc Symbols (e.g. ⭐️, ✨, ❤️)
    if (point >= 0x2b50 && point <= 0x2b55) return true; // Star, circle
    if (point >= 0x231a && point <= 0x23f3) return true; // Watch, hourglass
    if (point >= 0x1f000 && point <= 0x1faff) {
      if (point >= 0x1f3fb && point <= 0x1f3ff) return false; // Skin tone modifiers are combining
      return true;
    }
    if (point >= 0x1f1e6 && point <= 0x1f1ff) return true; // Regional indicator flags
    return false;
  }

  unicode.charWidth = function (str: any, i?: number) {
    const point = typeof str !== 'number' ? unicode.codePointAt(str, i || 0) : str;

    if (point >= 0xfe00 && point <= 0xfe0f) return 0;
    if (point === 0x200d) return 0;
    if (point >= 0x1f3fb && point <= 0x1f3ff) return 0;

    if (isModernEmoji(point)) return 2;

    return origCharWidth.call(this, str, i);
  };
}
